// SPDX-License-Identifier: AGPL-3.0-only
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectGitBranch } from "../../src/config.js";
import { hasTransientGitOperation } from "../../src/daemon/git-state.js";
import { startHeadWatcher, stopAllHeadWatchers } from "../../src/daemon/head-watcher.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "head-watcher-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
  execSync("git commit -q --allow-empty -m initial && git branch -M main", { cwd: repo });
});
afterEach(async () => {
  await stopAllHeadWatchers();
  rmSync(repo, { recursive: true, force: true });
});

describe("HEAD watcher", () => {
  it("fires onHeadChanged when a branch is checked out", async () => {
    const events: string[] = [];
    await startHeadWatcher(join(repo, ".git"), {
      onHeadChanged: (worktreeName) => {
        events.push(worktreeName);
      },
    });
    // Give the underlying parcel-watcher subscription a moment to attach before
    // mutating the filesystem; on macOS FSEvents misses events that happen
    // immediately after subscribe() returns.
    await new Promise((r) => setTimeout(r, 200));
    execSync("git checkout -qb feat-x", { cwd: repo });
    // Allow debounce + watcher latency to settle
    await new Promise((r) => setTimeout(r, 2000));
    expect(events).toContain(""); // "" = main worktree
  }, 10000);

  it("defers reindex during interactive rebase", () => {
    mkdirSync(join(repo, ".git", "rebase-merge"));
    expect(hasTransientGitOperation(join(repo, ".git"))).toBe(true);
    // The handler skips reindex when this returns true (covered by behavior test
    // in integration phase or via dependency injection).
  });

  // Degraded-mode fallback. The full file-watcher flow is hard to
  // exercise without spinning up a real watcher, so we assert on the building
  // block — `detectGitBranch` reflecting the post-checkout branch — that the
  // fallback in src/services/watcher.ts depends on. If this returns the wrong
  // value the fallback can't detect flips at all.
  it("detectGitBranch reflects checked-out branch (powers fallback flip detection)", () => {
    expect(detectGitBranch(repo)).toBe("main");
    execSync("git checkout -qb feat-fallback", { cwd: repo });
    expect(detectGitBranch(repo)).toBe("feat-fallback");
  });
});
