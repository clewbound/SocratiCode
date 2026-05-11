// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// HEAD-change handler: ties HEAD-watcher events to indexing decisions.
// Lives in its own module so head-watcher.ts and watchlist.ts can both depend
// on the watchlist without forming an import cycle.
import fs from "node:fs";
import path from "node:path";
import { detectGitBranch } from "../config.js";
import { updateProjectIndex } from "../services/indexer.js";
import { logger } from "../services/logger.js";
import { hasTransientGitOperation } from "./git-state.js";
import { type WatchlistEntry, watchlist } from "./watchlist.js";

/**
 * Build an `onHeadChanged` callback bound to `commonDir`. The returned function
 * receives the worktree name (`""` for the main worktree) and decides whether
 * to trigger a reindex based on:
 *   1. transient git ops (rebase/merge/cherry-pick) → defer
 *   2. detached HEAD → lazy (skip; reindex happens on next query)
 *   3. otherwise → fire-and-forget incremental reindex of the worktree path
 */
export function defaultHeadChangeHandler(commonDir: string): (wt: string) => void {
  return (worktreeName) => {
    const entry = lookupEntryByCommonDirAndName(commonDir, worktreeName);
    if (!entry) {
      logger.debug("HEAD change for unknown worktree", { commonDir, worktreeName });
      return;
    }
    // Touch BEFORE any deferral check: a HEAD flip is activity regardless of
    // whether we end up reindexing. Skipping the touch on transient-op or
    // detached-HEAD paths would let an actively-used worktree inactivity-evict
    // just because reindex was deferred at the moment of the event.
    watchlist.touch(entry.path);
    if (hasTransientGitOperation(commonDir)) {
      logger.info("git op in progress, deferring index", { path: entry.path });
      return;
    }
    const branch = detectGitBranch(entry.path);
    if (branch === null) {
      logger.info("detached HEAD, deferring index until queried", { path: entry.path });
      return;
    }
    // Fire-and-forget reindex on new branch
    updateProjectIndex(entry.path).catch((err) => {
      logger.error("post-flip reindex failed", {
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}

/**
 * Resolve a (commonDir, worktreeName) pair back to the watchlist entry that
 * tracks the on-disk path.
 *
 * - For `worktreeName === ""` (main worktree), the entry's commonDir matches
 *   AND `<entry.path>/.git === commonDir`.
 * - For linked worktrees, gitdir is `<common>/worktrees/<name>`; the on-disk
 *   path is the parent of whatever `<common>/worktrees/<name>/gitdir` points to.
 */
function lookupEntryByCommonDirAndName(
  commonDir: string,
  worktreeName: string,
): WatchlistEntry | undefined {
  if (worktreeName === "") {
    return watchlist
      .entries()
      .find((e) => entryCommonDirMatches(e, commonDir) && isMainWorktree(e, commonDir));
  }
  const linkedPath = readLinkedWorktreePath(commonDir, worktreeName);
  if (!linkedPath) return undefined;
  return watchlist.entries().find((e) => e.path === linkedPath);
}

function entryCommonDirMatches(entry: WatchlistEntry, commonDir: string): boolean {
  if (entry.commonDir === commonDir) return true;
  // Defend against /private/-canonicalized commonDir keys vs /var/-prefixed
  // entries (or vice versa) on macOS.
  try {
    return fs.realpathSync(entry.commonDir ?? "") === fs.realpathSync(commonDir);
  } catch {
    return false;
  }
}

function isMainWorktree(entry: WatchlistEntry, commonDir: string): boolean {
  // Main: commonDir is `<entry.path>/.git`. Compare via realpath where possible
  // to absorb /private prefix differences.
  const expected = path.join(entry.path, ".git");
  if (expected === commonDir) return true;
  try {
    return fs.realpathSync(expected) === fs.realpathSync(commonDir);
  } catch {
    return false;
  }
}

function readLinkedWorktreePath(commonDir: string, worktreeName: string): string | null {
  const gitdirFile = path.join(commonDir, "worktrees", worktreeName, "gitdir");
  try {
    const gitdirContents = fs.readFileSync(gitdirFile, "utf-8").trim();
    // Contents point at <worktree>/.git ; the worktree is its parent dir
    return path.dirname(gitdirContents);
  } catch {
    return null;
  }
}
