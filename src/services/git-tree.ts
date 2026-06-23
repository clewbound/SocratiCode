// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// Read every tracked file's git blob sha for the working tree at `projectPath`.
// Uses `git ls-files -s -z` so paths with embedded newlines are safe and we
// avoid invoking a shell. Returns null if the path is not a git working tree
// (no .git, detached worktree without git available, etc.) or if git fails —
// callers fall back to the normal scan path on null.
//
// Each output record is "<mode> <sha> <stage>\t<path>\0", e.g.:
//   "100644 a1b2c3...e4f5 0\tsrc/foo.ts\0"
//
// We only consume tracked files at stage 0 (no merge conflicts). Files in
// other stages are skipped — if there's an active merge conflict the fast
// paths shouldn't kick in anyway.
//
// SHA-1 only: this validator rejects entries whose blob hash isn't 40 hex
// chars. Repos with `extensions.objectFormat = sha256` (64-hex blobs) will
// produce an empty map → the fast path silently disables. Acceptable while
// SHA-256 git repos are vanishingly rare; revisit if anyone reports a
// no-op fast path on a SHA-256 repo.
//
// maxBuffer: 256 MiB is far above any realistic monorepo's `ls-files -s -z`
// output. If exceeded, execFile rejects and we return null (silent
// fast-path disable, debug-logged). For pathologically large indexes
// (hundreds of thousands of files), switch to streaming via spawn. TODO:
// streaming variant once a real repo trips the cap.
export async function getGitBlobShas(
  projectPath: string,
): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "ls-files", "-s", "-z"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const map = new Map<string, string>();
    for (const record of stdout.split("\0")) {
      if (record.length === 0) continue;
      const tabIdx = record.indexOf("\t");
      if (tabIdx === -1) continue;
      const meta = record.slice(0, tabIdx);
      const path = record.slice(tabIdx + 1);
      const parts = meta.split(" ");
      if (parts.length !== 3) continue;
      const [, sha, stage] = parts;
      if (stage !== "0") continue;
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      map.set(path, sha);
    }
    return map;
  } catch (err) {
    logger.debug("getGitBlobShas failed (treating as non-git or unreadable)", {
      projectPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface GitTreeDiff {
  unchanged: string[];
  modified: string[];
  added: string[];
  deleted: string[];
}

// Diff two git-blob-sha maps. Output arrays are deterministic (insertion order
// from the input Maps), so callers can rely on stable iteration. Cost is O(|prev| + |curr|).
export function diffGitTrees(
  prev: Map<string, string>,
  curr: Map<string, string>,
): GitTreeDiff {
  const unchanged: string[] = [];
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const [path, sha] of curr) {
    const prevSha = prev.get(path);
    if (prevSha === undefined) added.push(path);
    else if (prevSha === sha) unchanged.push(path);
    else modified.push(path);
  }
  for (const path of prev.keys()) {
    if (!curr.has(path)) deleted.push(path);
  }
  return { unchanged, modified, added, deleted };
}
