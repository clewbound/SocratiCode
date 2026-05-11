// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the downstream side-effects so the test focuses on the watchlist touch.
const hasTransientMock = vi.fn(() => false);
const updateProjectIndexMock = vi.fn(async () => ({
  added: 0,
  updated: 0,
  removed: 0,
  chunksCreated: 0,
  cancelled: false,
}));
const detectGitBranchMock = vi.fn(() => "develop");

vi.mock("../../src/daemon/git-state.js", () => ({
  hasTransientGitOperation: hasTransientMock,
}));
vi.mock("../../src/services/indexer.js", () => ({
  updateProjectIndex: updateProjectIndexMock,
}));
vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/config.js")>(
    "../../src/config.js",
  );
  return { ...actual, detectGitBranch: detectGitBranchMock };
});

let stateDir: string;
let projectPath: string;
let commonDir: string;

beforeEach(() => {
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "hh-wl-")));
  process.env.SOCRATICODE_STATE_DIR = stateDir;
  projectPath = realpathSync(mkdtempSync(join(tmpdir(), "hh-repo-")));
  mkdirSync(join(projectPath, ".git"));
  commonDir = join(projectPath, ".git");
  hasTransientMock.mockReturnValue(false);
  detectGitBranchMock.mockReturnValue("develop");
  updateProjectIndexMock.mockClear();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
  delete process.env.SOCRATICODE_STATE_DIR;
});

// Helpers go inside describe so module-mocks are applied before import.
describe("defaultHeadChangeHandler touches the watchlist entry", () => {
  async function setupOldEntry(): Promise<string> {
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    watchlist.add({
      path: projectPath,
      repoId: "r1",
      commonDir,
      addedVia: "implicit",
      addedAt: old,
    });
    // Force-rewind lastQueriedAt so the touch is observable; without this it
    // equals "now" from add().
    const entry = watchlist.entries().find((e) => e.path === projectPath);
    if (entry) entry.lastQueriedAt = old;
    return old;
  }

  it("touches lastQueriedAt on a normal branch flip", async () => {
    const { defaultHeadChangeHandler } = await import(
      "../../src/daemon/head-handler.js"
    );
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const oldStamp = await setupOldEntry();

    defaultHeadChangeHandler(commonDir)("");

    const entry = watchlist.entries().find((e) => e.path === projectPath);
    expect(entry).toBeDefined();
    expect(entry?.lastQueriedAt).not.toBe(oldStamp);
    expect(entry).toBeDefined();
    expect(Date.parse(entry?.lastQueriedAt ?? "")).toBeGreaterThan(Date.parse(oldStamp));
    // Side-effect: reindex was attempted (not awaited so flush microtasks).
    await Promise.resolve();
    expect(updateProjectIndexMock).toHaveBeenCalled();
  });

  // The touch must fire BEFORE the transient-op early-return: a long-running
  // rebase shouldn't cause the worktree to inactivity-evict just because
  // reindex is deferred.
  it("touches lastQueriedAt even when a transient git op defers reindex", async () => {
    hasTransientMock.mockReturnValue(true);
    const { defaultHeadChangeHandler } = await import(
      "../../src/daemon/head-handler.js"
    );
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const oldStamp = await setupOldEntry();

    defaultHeadChangeHandler(commonDir)("");

    const entry = watchlist.entries().find((e) => e.path === projectPath);
    expect(entry).toBeDefined();
    expect(Date.parse(entry?.lastQueriedAt ?? "")).toBeGreaterThan(Date.parse(oldStamp));
    expect(updateProjectIndexMock).not.toHaveBeenCalled();
  });

  // Detached HEAD path: also a valid activity signal — the user just
  // checked out a tag or a SHA, we shouldn't expire their watchlist entry.
  it("touches lastQueriedAt on detached HEAD (reindex deferred)", async () => {
    detectGitBranchMock.mockReturnValue(null);
    const { defaultHeadChangeHandler } = await import(
      "../../src/daemon/head-handler.js"
    );
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const oldStamp = await setupOldEntry();

    defaultHeadChangeHandler(commonDir)("");

    const entry = watchlist.entries().find((e) => e.path === projectPath);
    expect(entry).toBeDefined();
    expect(Date.parse(entry?.lastQueriedAt ?? "")).toBeGreaterThan(Date.parse(oldStamp));
    expect(updateProjectIndexMock).not.toHaveBeenCalled();
  });

  it("does NOT touch when the (commonDir, worktreeName) doesn't resolve to an entry", async () => {
    const { defaultHeadChangeHandler } = await import(
      "../../src/daemon/head-handler.js"
    );
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const oldStamp = await setupOldEntry();

    // Worktree name that doesn't exist under commonDir/worktrees/
    defaultHeadChangeHandler(commonDir)("nonexistent-wt");

    const entry = watchlist.entries().find((e) => e.path === projectPath);
    expect(entry?.lastQueriedAt).toBe(oldStamp);
  });
});
