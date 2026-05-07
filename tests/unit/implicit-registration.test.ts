// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorktrees } from "../../src/daemon/git-worktree.js";
import { registerPath, resolveToRegisteredRoot, watchlist } from "../../src/daemon/watchlist.js";
import { stopAllWatchers } from "../../src/services/watcher.js";

let main: string;
beforeEach(() => {
  main = realpathSync(mkdtempSync(join(tmpdir(), "wt-main-")));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: main });
  execSync("git commit -q --allow-empty -m initial", { cwd: main });
});
afterEach(async () => {
  await stopAllWatchers();
  rmSync(main, { recursive: true, force: true });
});

describe("listWorktrees", () => {
  it("returns just the main worktree when no linked worktrees exist", async () => {
    const wts = await listWorktrees(main);
    expect(wts.length).toBe(1);
    expect(wts[0]?.path).toBe(main);
    expect(wts[0]?.isMain).toBe(true);
  });

  it("returns main + linked when a worktree is added", async () => {
    const linkedRaw = mkdtempSync(join(tmpdir(), "wt-linked-"));
    rmSync(linkedRaw, { recursive: true, force: true });
    execSync(`git worktree add -q ${linkedRaw} -b feat-x`, { cwd: main });
    // Real path may differ from raw mkdtemp path on macOS (/var -> /private/var)
    const linked = realpathSync(linkedRaw);
    try {
      const wts = await listWorktrees(main);
      expect(wts.length).toBe(2);
      const paths = wts.map((w) => w.path).sort();
      expect(paths).toEqual([linked, main].sort());
      const linkedEntry = wts.find((w) => w.path === linked);
      expect(linkedEntry?.branch).toBe("feat-x");
      expect(linkedEntry?.isMain).toBe(false);
    } finally {
      execSync(`git worktree remove ${linkedRaw}`, { cwd: main });
    }
  });

  it("returns empty array on non-git path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "non-git-"));
    try {
      const wts = await listWorktrees(tmp);
      expect(wts).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveToRegisteredRoot", () => {
  it("returns the registered ancestor for a subdirectory path", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    process.env.SOCRATICODE_STATE_DIR = stateDir;
    try {
      // Mutate the module-level singleton (production code path).
      watchlist.load();
      for (const e of watchlist.entries()) watchlist.remove(e.path);
      watchlist.add({
        path: "/repos/foo",
        repoId: "r1",
        commonDir: null,
        addedVia: "explicit",
      });
      expect(resolveToRegisteredRoot("/repos/foo/src/sub/file.ts")).toBe("/repos/foo");
    } finally {
      for (const e of watchlist.entries()) watchlist.remove(e.path);
      delete process.env.SOCRATICODE_STATE_DIR;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns the input unchanged when no registered ancestor exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    process.env.SOCRATICODE_STATE_DIR = stateDir;
    try {
      watchlist.load();
      for (const e of watchlist.entries()) watchlist.remove(e.path);
      expect(resolveToRegisteredRoot("/totally/unknown")).toBe("/totally/unknown");
    } finally {
      delete process.env.SOCRATICODE_STATE_DIR;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("registerPath", () => {
  it("registers main + sibling worktrees on first call", async () => {
    const linkedRaw = mkdtempSync(join(tmpdir(), "wt-linked-"));
    rmSync(linkedRaw, { recursive: true, force: true });
    execSync(`git worktree add -q ${linkedRaw} -b feat-x`, { cwd: main });
    const linked = realpathSync(linkedRaw);
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    process.env.SOCRATICODE_STATE_DIR = stateDir;
    try {
      // Reset the singleton against the fresh state dir.
      watchlist.load();
      // Sanity: clear any stale entries that might leak across tests.
      for (const e of watchlist.entries()) watchlist.remove(e.path);

      await registerPath(main, "implicit");

      const paths = watchlist.entries().map((e) => e.path).sort();
      expect(paths).toEqual([linked, main].sort());
    } finally {
      // Cleanup before removing the worktree (otherwise git complains).
      for (const e of watchlist.entries()) watchlist.remove(e.path);
      delete process.env.SOCRATICODE_STATE_DIR;
      rmSync(stateDir, { recursive: true, force: true });
      execSync(`git worktree remove ${linkedRaw}`, { cwd: main });
    }
  });
});
