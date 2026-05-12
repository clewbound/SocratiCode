// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for a phase-11 callsite miss: `initWatchlist` re-arms
// persisted entries on daemon startup but originally did NOT pass the
// `onActivity` callback into `startWatching`. That meant file activity on
// any persisted worktree never touched `lastQueriedAt`, so an actively-used
// worktree could still inactivity-evict after 14 days *across daemon
// restarts*. The fresh `registerPath` flow already passed the callback; this
// test covers the re-arm path.

const startWatchingMock = vi.fn(async () => true);
vi.mock("../../src/services/watcher.js", () => ({
  startWatching: startWatchingMock,
}));

// Head-watcher subsystem is unrelated to this test and pulls in heavy deps;
// mock it so initHeadWatcher isn't exercised at import time.
vi.mock("../../src/daemon/head-watcher.js", () => ({
  startHeadWatcher: vi.fn(async () => undefined),
}));

let stateDir: string;
let projectPath: string;

beforeEach(() => {
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "init-wl-")));
  process.env.SOCRATICODE_STATE_DIR = stateDir;
  projectPath = realpathSync(mkdtempSync(join(tmpdir(), "init-wl-repo-")));
  mkdirSync(join(projectPath, ".git"));
  startWatchingMock.mockClear();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
  delete process.env.SOCRATICODE_STATE_DIR;
});

describe("initWatchlist re-arm passes the activity callback", () => {
  it("invokes startWatching with an onActivity callback that touches the entry", async () => {
    const { watchlist } = await import("../../src/daemon/watchlist.js");
    const { initWatchlist } = await import("../../src/daemon/index.js");

    watchlist.add({
      path: projectPath,
      repoId: "r1",
      commonDir: join(projectPath, ".git"),
      addedVia: "implicit",
    });
    // Rewind lastQueriedAt so the touch is observable.
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const entry = watchlist.entries().find((e) => e.path === projectPath);
    if (entry) entry.lastQueriedAt = old;

    await initWatchlist();

    expect(startWatchingMock).toHaveBeenCalled();
    const call = startWatchingMock.mock.calls.find(
      (c) => c[0] === projectPath,
    );
    expect(call).toBeDefined();
    const onActivity = call?.[2];
    expect(typeof onActivity).toBe("function");

    // Simulate a debounce-burst firing the callback.
    (onActivity as () => void)();

    const after = watchlist.entries().find((e) => e.path === projectPath);
    expect(after).toBeDefined();
    expect(Date.parse(after?.lastQueriedAt ?? "")).toBeGreaterThan(
      Date.parse(old),
    );
  });
});
