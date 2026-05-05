// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportInfo } from "../../src/services/graph-imports.js";
import type { ExtractedSymbols } from "../../src/services/graph-symbols.js";

// Mirror the point id derived in production so retrieve mocks return the
// same id Qdrant would have echoed back.
function buildPointId(lang: string, blobSha: string, schemaVersion = 1): string {
  const key = `${schemaVersion}:${lang}:${blobSha}`;
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const { mockUpsert, mockRetrieve, mockEnsure } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockRetrieve: vi.fn(),
  mockEnsure: vi.fn(),
}));

vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({ upsert: mockUpsert, retrieve: mockRetrieve }),
  ensureSymbolCacheCollection: mockEnsure,
}));

import {
  lookupSymbolCacheBatch,
  SYMBOL_CACHE_COLLECTION,
  SYMBOL_CACHE_SCHEMA_VERSION,
  symbolCacheKey,
  writeSymbolCacheBatch,
} from "../../src/services/symbol-cache.js";

const sampleSymbols: ExtractedSymbols["symbols"] = [
  {
    id: "a.ts::<module>#1",
    name: "<module>",
    qualifiedName: "<module>",
    kind: "module",
    file: "a.ts",
    line: 1,
    endLine: 5,
    language: "typescript",
  },
  {
    id: "a.ts::foo#2",
    name: "foo",
    qualifiedName: "foo",
    kind: "function",
    file: "a.ts",
    line: 2,
    endLine: 4,
    language: "typescript",
  },
];
const sampleRawCalls: ExtractedSymbols["rawCalls"] = [
  {
    callerId: "a.ts::foo#2",
    calleeName: "bar",
    callSite: { file: "a.ts", line: 3 },
  },
];
const sampleImports: ImportInfo[] = [
  { moduleSpecifier: "./b", isDynamic: false },
];

beforeEach(() => {
  mockUpsert.mockReset().mockResolvedValue(undefined);
  mockRetrieve.mockReset().mockResolvedValue([]);
  mockEnsure.mockReset().mockResolvedValue(undefined);
});

describe("symbolCacheKey", () => {
  it("includes schema version, language, and blob sha", () => {
    const k = symbolCacheKey("typescript", "abc123");
    expect(k).toContain("typescript");
    expect(k).toContain("abc123");
    expect(k.startsWith(`${SYMBOL_CACHE_SCHEMA_VERSION}:`)).toBe(true);
  });

  it("differs when language differs (same blob)", () => {
    expect(symbolCacheKey("c", "deadbeef")).not.toBe(symbolCacheKey("cpp", "deadbeef"));
  });

  it("is stable for identical inputs", () => {
    expect(symbolCacheKey("typescript", "abc")).toBe(symbolCacheKey("typescript", "abc"));
  });
});

describe("lookupSymbolCacheBatch", () => {
  it("returns an empty map and skips qdrant when given no entries", async () => {
    const result = await lookupSymbolCacheBatch([]);
    expect(result.size).toBe(0);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("issues a single retrieve for many entries", async () => {
    mockRetrieve.mockResolvedValue([]);
    await lookupSymbolCacheBatch([
      { lang: "typescript", blobSha: "h1" },
      { lang: "typescript", blobSha: "h2" },
      { lang: "go", blobSha: "h3" },
    ]);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    const [collection, body] = mockRetrieve.mock.calls[0];
    expect(collection).toBe(SYMBOL_CACHE_COLLECTION);
    expect(body.ids).toHaveLength(3);
    expect(body.with_payload).toBe(true);
  });

  it("dedupes ids when input contains duplicate (lang, blobSha) pairs", async () => {
    mockRetrieve.mockResolvedValue([]);
    await lookupSymbolCacheBatch([
      { lang: "typescript", blobSha: "dup" },
      { lang: "typescript", blobSha: "dup" },
      { lang: "typescript", blobSha: "other" },
    ]);
    const sentIds: string[] = mockRetrieve.mock.calls[0][1].ids;
    expect(sentIds).toHaveLength(2);
    expect(new Set(sentIds).size).toBe(sentIds.length);
  });

  it("returns a map keyed by symbolCacheKey() with hits resolved", async () => {
    mockRetrieve.mockResolvedValue([
      {
        id: buildPointId("typescript", "alpha"),
        payload: {
          schemaVersion: SYMBOL_CACHE_SCHEMA_VERSION,
          lang: "typescript",
          blobSha: "alpha",
          symbols: sampleSymbols,
          rawCalls: sampleRawCalls,
          imports: sampleImports,
          storedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    ]);
    const result = await lookupSymbolCacheBatch([
      { lang: "typescript", blobSha: "alpha" },
      { lang: "typescript", blobSha: "beta" },
    ]);
    expect(result.size).toBe(1);
    const entry = result.get(symbolCacheKey("typescript", "alpha"));
    expect(entry).toBeDefined();
    expect(entry?.symbols).toEqual(sampleSymbols);
    expect(entry?.rawCalls).toEqual(sampleRawCalls);
    expect(entry?.imports).toEqual(sampleImports);
    expect(result.has(symbolCacheKey("typescript", "beta"))).toBe(false);
  });

  it("filters out points whose schema version differs (defensive)", async () => {
    mockRetrieve.mockResolvedValue([
      {
        id: buildPointId("typescript", "good"),
        payload: {
          schemaVersion: SYMBOL_CACHE_SCHEMA_VERSION,
          lang: "typescript",
          blobSha: "good",
          symbols: sampleSymbols,
          rawCalls: sampleRawCalls,
          imports: sampleImports,
          storedAt: "",
        },
      },
      {
        id: buildPointId("typescript", "stale"),
        payload: {
          schemaVersion: SYMBOL_CACHE_SCHEMA_VERSION + 99,
          lang: "typescript",
          blobSha: "stale",
          symbols: sampleSymbols,
          rawCalls: sampleRawCalls,
          imports: sampleImports,
          storedAt: "",
        },
      },
    ]);
    const result = await lookupSymbolCacheBatch([
      { lang: "typescript", blobSha: "good" },
      { lang: "typescript", blobSha: "stale" },
    ]);
    expect(result.has(symbolCacheKey("typescript", "good"))).toBe(true);
    expect(result.has(symbolCacheKey("typescript", "stale"))).toBe(false);
  });

  it("returns an empty map when qdrant retrieve throws (best-effort)", async () => {
    mockRetrieve.mockRejectedValue(new Error("qdrant down"));
    const result = await lookupSymbolCacheBatch([{ lang: "ts", blobSha: "h" }]);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when ensure throws (best-effort)", async () => {
    mockEnsure.mockRejectedValue(new Error("ensure failed"));
    const result = await lookupSymbolCacheBatch([{ lang: "ts", blobSha: "h" }]);
    expect(result.size).toBe(0);
  });
});

describe("writeSymbolCacheBatch", () => {
  it("upserts one point per (lang, blobSha) into the cache collection", async () => {
    await writeSymbolCacheBatch([
      {
        lang: "typescript",
        blobSha: "h1",
        symbols: sampleSymbols,
        rawCalls: sampleRawCalls,
        imports: sampleImports,
      },
    ]);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [collection, body] = mockUpsert.mock.calls[0];
    expect(collection).toBe(SYMBOL_CACHE_COLLECTION);
    expect(body.points).toHaveLength(1);
    expect(body.wait).toBe(false);
    const point = body.points[0];
    expect(point.payload.schemaVersion).toBe(SYMBOL_CACHE_SCHEMA_VERSION);
    expect(point.payload.lang).toBe("typescript");
    expect(point.payload.blobSha).toBe("h1");
    expect(point.payload.symbols).toEqual(sampleSymbols);
    expect(point.payload.rawCalls).toEqual(sampleRawCalls);
    expect(point.payload.imports).toEqual(sampleImports);
  });

  it("dedupes entries within a single batch", async () => {
    await writeSymbolCacheBatch([
      { lang: "typescript", blobSha: "dup", symbols: [], rawCalls: [], imports: [] },
      { lang: "typescript", blobSha: "dup", symbols: [], rawCalls: [], imports: [] },
      { lang: "typescript", blobSha: "other", symbols: [], rawCalls: [], imports: [] },
    ]);
    const body = mockUpsert.mock.calls[0][1];
    expect(body.points).toHaveLength(2);
  });

  it("ensures the cache collection before upserting", async () => {
    await writeSymbolCacheBatch([
      { lang: "ts", blobSha: "h", symbols: [], rawCalls: [], imports: [] },
    ]);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpsert.mock.invocationCallOrder[0],
    );
  });

  it("uses the same point id for the same (lang, blobSha)", async () => {
    await writeSymbolCacheBatch([
      { lang: "ts", blobSha: "same", symbols: [], rawCalls: [], imports: [] },
    ]);
    await writeSymbolCacheBatch([
      { lang: "ts", blobSha: "same", symbols: [], rawCalls: [], imports: [] },
    ]);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const id1 = mockUpsert.mock.calls[0][1].points[0].id;
    const id2 = mockUpsert.mock.calls[1][1].points[0].id;
    expect(id1).toBe(id2);
  });

  it("does not throw when qdrant upsert errors (best-effort)", async () => {
    mockUpsert.mockRejectedValue(new Error("qdrant down"));
    await expect(
      writeSymbolCacheBatch([
        { lang: "ts", blobSha: "h", symbols: [], rawCalls: [], imports: [] },
      ]),
    ).resolves.toBeUndefined();
  });

  it("does not throw when ensure errors (best-effort)", async () => {
    mockEnsure.mockRejectedValue(new Error("ensure failed"));
    await expect(
      writeSymbolCacheBatch([
        { lang: "ts", blobSha: "h", symbols: [], rawCalls: [], imports: [] },
      ]),
    ).resolves.toBeUndefined();
  });

  it("skips qdrant when given an empty batch", async () => {
    await writeSymbolCacheBatch([]);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
