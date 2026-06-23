// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Verifies that buildCodeGraph integrates with the blob-sha-keyed symbol
 * cache: misses parse + queue a write; hits skip parse and reuse the
 * cached extraction. Mocks the Qdrant client so this stays a unit test
 * (no Docker), but uses a real on-disk fixture and real ast-grep parses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpsert, mockRetrieve, mockEnsure } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockRetrieve: vi.fn(),
  mockEnsure: vi.fn(),
}));

vi.mock("../../src/services/qdrant.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getClient: () => ({ upsert: mockUpsert, retrieve: mockRetrieve }),
    ensureSymbolCacheCollection: mockEnsure,
  };
});

import {
  buildCodeGraph,
  ensureDynamicLanguages,
} from "../../src/services/code-graph.js";

let projectRoot: string;

beforeEach(() => {
  ensureDynamicLanguages();
  mockUpsert.mockReset().mockResolvedValue(undefined);
  mockRetrieve.mockReset().mockResolvedValue([]);
  mockEnsure.mockReset().mockResolvedValue(undefined);
  delete process.env.SOCRATICODE_SYMBOL_CACHE;

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-symcache-"));
  fs.writeFileSync(
    path.join(projectRoot, "a.ts"),
    `export function alpha(): number { return 1; }\nalpha();\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, "b.ts"),
    `import { alpha } from "./a.js";\nexport function beta(): number { return alpha() + 1; }\n`,
  );
});

afterEach(() => {
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("buildCodeGraph + symbol cache", () => {
  it("queues a cache write per file when no entry exists (full miss)", async () => {
    const blobShas = new Map<string, string>([
      ["a.ts", "blob-a"],
      ["b.ts", "blob-b"],
    ]);
    mockRetrieve.mockResolvedValue([]); // full miss

    const built = await buildCodeGraph(projectRoot, undefined, undefined, blobShas);
    expect(built.symbolsByFile.size).toBeGreaterThan(0);

    // One retrieve for the batch lookup, one upsert for the batch write.
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    const upsertBody = mockUpsert.mock.calls[0][1];
    expect(upsertBody.wait).toBe(false);
    // 2 source files, both .ts → both should have queued cache writes.
    expect(upsertBody.points).toHaveLength(2);

    // Each cached payload carries lang, blobSha, symbols, rawCalls, imports.
    for (const point of upsertBody.points) {
      expect(point.payload.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(typeof point.payload.lang).toBe("string");
      expect(["blob-a", "blob-b"]).toContain(point.payload.blobSha);
      expect(Array.isArray(point.payload.symbols)).toBe(true);
      expect(Array.isArray(point.payload.rawCalls)).toBe(true);
      expect(Array.isArray(point.payload.imports)).toBe(true);
    }
  });

  it("skips the parse path on cache hit and does not queue a write", async () => {
    const blobShas = new Map<string, string>([
      ["a.ts", "blob-a"],
      ["b.ts", "blob-b"],
    ]);

    // First build: full miss → one upsert containing both files. Capture
    // the payload so the second build can replay it as a hit.
    await buildCodeGraph(projectRoot, undefined, undefined, blobShas);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const writtenPoints: Array<{ id: string; payload: Record<string, unknown> }> =
      mockUpsert.mock.calls[0][1].points;

    // Reset write/retrieve counts for the second build, but configure
    // retrieve to return the previously-written points (cache hit on both).
    mockUpsert.mockClear();
    mockRetrieve.mockReset().mockImplementation(async (_coll: string, body: { ids: string[] }) => {
      return writtenPoints.filter((p) => body.ids.includes(p.id));
    });

    const built = await buildCodeGraph(projectRoot, undefined, undefined, blobShas);

    // Cache lookup happened, but no new writes (every file was a hit).
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();

    // Symbols + edges still populated from cached payloads — the file-import
    // graph is rebuilt from cached imports, not by reparsing.
    expect(built.symbolsByFile.size).toBeGreaterThan(0);
    expect(built.edges.length).toBeGreaterThan(0);
  });

  it("skips cache entirely when SOCRATICODE_SYMBOL_CACHE=0", async () => {
    process.env.SOCRATICODE_SYMBOL_CACHE = "0";
    const blobShas = new Map<string, string>([["a.ts", "blob-a"], ["b.ts", "blob-b"]]);

    await buildCodeGraph(projectRoot, undefined, undefined, blobShas);

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("skips cache entirely when no gitBlobShas are provided", async () => {
    await buildCodeGraph(projectRoot, undefined, undefined, undefined);

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("does not queue a cache write for files missing from gitBlobShas", async () => {
    // Only `a.ts` is tracked; `b.ts` has no blob sha, so it should bypass
    // the cache entirely (parsed normally, not queued for write).
    const blobShas = new Map<string, string>([["a.ts", "blob-a"]]);
    mockRetrieve.mockResolvedValue([]);

    await buildCodeGraph(projectRoot, undefined, undefined, blobShas);

    // Lookup runs only for `a.ts`.
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockRetrieve.mock.calls[0][1].ids).toHaveLength(1);

    // Write batch contains only `a.ts`.
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const points = mockUpsert.mock.calls[0][1].points;
    expect(points).toHaveLength(1);
    expect(points[0].payload.blobSha).toBe("blob-a");
  });
});
