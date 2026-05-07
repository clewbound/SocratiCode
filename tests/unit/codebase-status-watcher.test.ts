// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Unit tests for the daemon-mode `Watcher:` block in codebase_status output.
 * Verifies that under SOCRATICODE_DAEMON_MODE=true the status output gains a
 * Watcher section with active/repoId/branch fields, and that stdio mode output
 * is unchanged (no Watcher block).
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/services/docker.js", () => ({
  ensureQdrantReady: vi.fn(async () => ({ pulled: false, started: false })),
  isDockerAvailable: vi.fn(async () => true),
}));

vi.mock("../../src/services/qdrant.js", () => ({
  searchChunks: vi.fn(async () => []),
  searchMultipleCollections: vi.fn(async () => []),
  // Returning an object (not null) drives the codebase_status case past the
  // "No index found" early return and into the statusLines accumulator path
  // where the Watcher: block is appended.
  getCollectionInfo: vi.fn(async () => ({ status: "green", pointsCount: 0 })),
  getProjectMetadata: vi.fn(async () => null),
}));

vi.mock("../../src/services/indexer.js", () => ({
  isIndexingInProgress: vi.fn(() => false),
  getIndexingProgress: vi.fn(() => null),
  getLastCompleted: vi.fn(() => null),
}));

vi.mock("../../src/services/code-graph.js", () => ({
  getGraphStatus: vi.fn(async () => null),
}));

vi.mock("../../src/services/context-artifacts.js", () => ({
  getArtifactStatusSummary: vi.fn(async () => null),
}));

vi.mock("../../src/services/watcher.js", () => ({
  ensureWatcherStarted: vi.fn(),
  isWatching: vi.fn(() => false),
  isWatchedByAnyProcess: vi.fn(async () => false),
}));

vi.mock("../../src/services/lock.js", () => ({
  getLockHolderPid: vi.fn(async () => null),
}));

vi.mock("../../src/daemon/watchlist.js", () => ({
  maybeRegisterFromTool: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────

import { handleQueryTool } from "../../src/tools/query-tools.js";

// ── Tests ────────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "status-watcher-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
  execSync("git commit -q --allow-empty -m initial && git branch -M main", { cwd: tmp });
});

afterEach(() => {
  delete process.env.SOCRATICODE_DAEMON_MODE;
  rmSync(tmp, { recursive: true, force: true });
});

describe("codebase_status — daemon-mode Watcher block", () => {
  it("output includes a Watcher section in daemon mode", async () => {
    process.env.SOCRATICODE_DAEMON_MODE = "true";
    const text = await handleQueryTool("codebase_status", { projectPath: tmp });
    expect(text).toMatch(/Watcher:/);
    expect(text).toMatch(/branch=main/);
    expect(text).toMatch(/active=false/);
    expect(text).toMatch(/repoId=/);
  });

  it("watcher block is OMITTED in stdio mode (no env flag)", async () => {
    delete process.env.SOCRATICODE_DAEMON_MODE;
    const text = await handleQueryTool("codebase_status", { projectPath: tmp });
    expect(text).not.toMatch(/Watcher:/);
    // Pre-existing "File watcher:" line is unrelated and should still appear
    expect(text).toMatch(/File watcher:/);
  });

  it("watcher block is OMITTED when env flag is not exactly 'true'", async () => {
    process.env.SOCRATICODE_DAEMON_MODE = "1";
    const text = await handleQueryTool("codebase_status", { projectPath: tmp });
    expect(text).not.toMatch(/Watcher:/);
  });
});
