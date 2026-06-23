// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";

const TRANSIENT_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

/**
 * Returns true when a transient git operation (rebase/merge/cherry-pick/etc.)
 * is in flight under the given common-dir. Used to defer index updates so we
 * don't react to every intermediate HEAD change during e.g. interactive rebase.
 */
export function hasTransientGitOperation(commonDir: string): boolean {
  for (const marker of TRANSIENT_MARKERS) {
    if (fs.existsSync(path.join(commonDir, marker))) return true;
  }
  return false;
}

/**
 * Map a fs-event path under <common-dir> back to the worktree it represents.
 * - <common-dir>/HEAD                 → "" (main worktree; caller resolves disk path)
 * - <common-dir>/worktrees/<n>/HEAD   → "<n>" (linked worktree name)
 * - anything else                      → null (caller should ignore the event)
 */
export function worktreeNameFromHeadPath(commonDir: string, eventPath: string): string | null {
  const rel = path.relative(commonDir, eventPath);
  if (rel === "HEAD") return ""; // main worktree
  const m = /^worktrees[/\\]([^/\\]+)[/\\]HEAD$/.exec(rel);
  return m ? (m[1] ?? null) : null;
}
