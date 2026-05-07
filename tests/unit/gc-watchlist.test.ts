// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gc-wl-"));
  process.env.SOCRATICODE_STATE_DIR = stateDir;
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.SOCRATICODE_STATE_DIR;
});

/**
 * Helper: write a watchlist file with crafted timestamps.
 * Used to seed inactivity scenarios without waiting 14 days.
 */
function seedWatchlist(
  dir: string,
  entries: Array<{
    path: string;
    repoId: string;
    commonDir: string | null;
    addedVia: "implicit" | "explicit";
    addedAt: string;
    lastQueriedAt: string;
  }>,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "watchlist.json"),
    JSON.stringify({ version: 1, entries }, null, 2),
    "utf-8",
  );
}

describe("watchlist GC", () => {
  it("drops implicit entry inactive for > 14 days when path is missing on disk", async () => {
    // Use a path that genuinely does not exist; the GC will see missing-on-disk first.
    const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    seedWatchlist(stateDir, [
      {
        path: "/definitely/does/not/exist/socraticode-test",
        repoId: "r1",
        commonDir: null,
        addedVia: "implicit",
        addedAt: oldTime,
        lastQueriedAt: oldTime,
      },
    ]);
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const { runWatchlistGc } = await import("../../src/daemon/gc.js");
    watchlist.load();
    const report = await runWatchlistGc({ dryRun: false });
    expect(report.removed.map((r) => r.path)).toContain(
      "/definitely/does/not/exist/socraticode-test",
    );
  });

  it("drops implicit entry inactive for > 14 days when path exists but is unused", async () => {
    const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    seedWatchlist(stateDir, [
      {
        path: stateDir, // exists on disk
        repoId: "r1",
        commonDir: null,
        addedVia: "implicit",
        addedAt: oldTime,
        lastQueriedAt: oldTime,
      },
    ]);
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const { runWatchlistGc } = await import("../../src/daemon/gc.js");
    watchlist.load();
    const report = await runWatchlistGc({ dryRun: false });
    expect(report.removed.map((r) => r.reason)).toContain("inactive");
  });

  it("does NOT drop sticky entries even when inactive", async () => {
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    seedWatchlist(stateDir, [
      {
        path: stateDir,
        repoId: "r1",
        commonDir: null,
        addedVia: "explicit",
        addedAt: oldTime,
        lastQueriedAt: oldTime,
      },
    ]);
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const { runWatchlistGc } = await import("../../src/daemon/gc.js");
    watchlist.load();
    const report = await runWatchlistGc({ dryRun: false });
    expect(report.removed).toEqual([]);
    expect(watchlist.has(stateDir)).toBe(true);
  });

  it("dry-run reports without mutating the watchlist", async () => {
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    seedWatchlist(stateDir, [
      {
        path: stateDir,
        repoId: "r1",
        commonDir: null,
        addedVia: "implicit",
        addedAt: oldTime,
        lastQueriedAt: oldTime,
      },
    ]);
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const { runWatchlistGc } = await import("../../src/daemon/gc.js");
    watchlist.load();
    const before = watchlist.entries().length;
    const dry = await runWatchlistGc({ dryRun: true });
    expect(dry.removed.length).toBeGreaterThan(0);
    expect(watchlist.entries().length).toBe(before);
  });
});
