// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface Worktree {
  /** Absolute path to the worktree (as reported by git). */
  path: string;
  /** Branch name (e.g. "main"); null when HEAD is detached. */
  branch: string | null;
  /** True for the primary worktree (the first entry in `git worktree list --porcelain`). */
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain` for any worktree of a repo.
 * Returns an empty array when `anyWorktreePath` is not inside a git repo.
 */
export async function listWorktrees(anyWorktreePath: string): Promise<Worktree[]> {
  let stdout: string;
  try {
    const result = await execFileP(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: path.resolve(anyWorktreePath), timeout: 5000 },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const out: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;
  let isFirst = true;
  const flush = () => {
    if (cur?.path) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? null,
        isMain: cur.isMain ?? false,
      });
    }
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), isMain: isFirst };
      isFirst = false;
    } else if (line.startsWith("branch refs/heads/")) {
      if (cur) cur.branch = line.slice("branch refs/heads/".length);
    } else if (line === "detached") {
      if (cur) cur.branch = null;
    }
  }
  flush();
  return out;
}
