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
