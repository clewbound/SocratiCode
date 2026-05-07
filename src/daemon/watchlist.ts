// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectGitCommonDir, resolveRepoId } from "../config.js";
import { logger } from "../services/logger.js";
import { startWatching } from "../services/watcher.js";
import { listWorktrees } from "./git-worktree.js";

export interface WatchlistEntry {
  path: string;
  repoId: string;
  commonDir: string | null;
  addedVia: "implicit" | "explicit";
  addedAt: string;
  lastQueriedAt: string;
}

interface FileShape {
  version: 1;
  entries: WatchlistEntry[];
}

const FILE_NAME = "watchlist.json";

/**
 * Resolve the state directory fresh on every call. We intentionally do NOT
 * cache this in a module-level constant or a constructor-bound field — the
 * `SOCRATICODE_STATE_DIR` env var must be re-readable per call so tests (and
 * embedded users) can swap directories between operations without rebuilding
 * the singleton.
 */
function stateDirCurrent(): string {
  if (process.env.SOCRATICODE_STATE_DIR) return process.env.SOCRATICODE_STATE_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "socraticode");
  }
  return path.join(os.homedir(), ".local", "state", "socraticode");
}

export class Watchlist {
  private byPath = new Map<string, WatchlistEntry>();

  /**
   * Compute the watchlist file path fresh each call so callers can change
   * `SOCRATICODE_STATE_DIR` between operations without recreating the instance.
   */
  private filePath(): string {
    return path.join(stateDirCurrent(), FILE_NAME);
  }

  load(): void {
    const file = this.filePath();
    if (!fs.existsSync(file)) {
      this.byPath.clear();
      return;
    }
    let parsed: FileShape;
    try {
      const raw = fs.readFileSync(file, "utf-8");
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn("watchlist parse failed, starting empty", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.byPath.clear();
      return;
    }
    this.byPath.clear();
    if (parsed.version === 1 && Array.isArray(parsed.entries)) {
      for (const e of parsed.entries) this.byPath.set(e.path, e);
    }
  }

  entries(): WatchlistEntry[] {
    return Array.from(this.byPath.values());
  }

  has(p: string): boolean {
    return this.byPath.has(p);
  }

  get(p: string): WatchlistEntry | undefined {
    return this.byPath.get(p);
  }

  add(input: Omit<WatchlistEntry, "addedAt" | "lastQueriedAt"> & { addedAt?: string }): void {
    const now = new Date().toISOString();
    const existing = this.byPath.get(input.path);
    if (existing) {
      // promote implicit -> explicit only; never demote
      existing.addedVia = input.addedVia === "explicit" ? "explicit" : existing.addedVia;
      existing.repoId = input.repoId;
      existing.commonDir = input.commonDir;
      existing.lastQueriedAt = now;
      this.persist();
      return;
    }
    this.byPath.set(input.path, {
      path: input.path,
      repoId: input.repoId,
      commonDir: input.commonDir,
      addedVia: input.addedVia,
      addedAt: input.addedAt ?? now,
      lastQueriedAt: now,
    });
    this.persist();
  }

  touch(p: string): void {
    const entry = this.byPath.get(p);
    if (!entry) return;
    entry.lastQueriedAt = new Date().toISOString();
    this.persist();
  }

  remove(p: string): boolean {
    if (!this.byPath.delete(p)) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    const file = this.filePath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const data: FileShape = { version: 1, entries: this.entries() };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  }
}

/**
 * Module-level singleton. Reads `SOCRATICODE_STATE_DIR` fresh on every
 * `load()`/`persist()` call (see `filePath()`), so tests that swap the env
 * var still work correctly without re-importing the module.
 */
export const watchlist = new Watchlist();

/**
 * Register a path with the daemon's watchlist, plus all sibling worktrees of
 * its repo. Idempotent: registering an already-registered path just touches
 * its `lastQueriedAt`.
 *
 * Triggered by:
 *  - first MCP tool call referencing a path the daemon doesn't know
 *  - explicit `socraticode daemon watch <path>` CLI (phase 7)
 *
 * @param p   absolute or relative path
 * @param via "implicit" (auto on tool call) or "explicit" (sticky, exempt from
 *            inactivity GC)
 */
export async function registerPath(p: string, via: "implicit" | "explicit"): Promise<void> {
  const resolved = path.resolve(p);
  if (watchlist.has(resolved)) {
    watchlist.touch(resolved);
    return;
  }
  const repoId = (() => {
    try {
      return resolveRepoId(resolved);
    } catch {
      return null;
    }
  })();
  if (!repoId) return; // SOCRATICODE_REPO_ID misconfig etc. — skip silently

  const commonDir = detectGitCommonDir(resolved);

  // Add the queried path first.
  watchlist.add({ path: resolved, repoId, commonDir, addedVia: via });
  await startWatching(resolved).catch(() => {
    /* watcher logs its own errors */
  });

  // Auto-expand siblings (only for git checkouts).
  if (commonDir) {
    const siblings = await listWorktrees(resolved);
    for (const wt of siblings) {
      if (wt.path === resolved) continue;
      if (watchlist.has(wt.path)) continue;
      const sibRepoId = (() => {
        try {
          return resolveRepoId(wt.path);
        } catch {
          return null;
        }
      })();
      if (!sibRepoId) continue;
      watchlist.add({
        path: wt.path,
        repoId: sibRepoId,
        commonDir: detectGitCommonDir(wt.path),
        addedVia: "implicit", // siblings are always implicit; user can promote later
      });
      await startWatching(wt.path).catch(() => {
        /* watcher logs its own errors */
      });
    }
  }
}

/**
 * Fire-and-forget hook for tool handlers. Only registers when running in
 * daemon mode, so stdio behavior is unchanged.
 *
 * Walks up from `p` to the nearest registered ancestor (subdirectory paths
 * resolve to their already-watched root) before delegating to `registerPath`.
 */
export function maybeRegisterFromTool(p: string): void {
  if (process.env.SOCRATICODE_DAEMON_MODE !== "true") return;
  const root = resolveToRegisteredRoot(p);
  if (watchlist.has(root)) {
    watchlist.touch(root);
    return;
  }
  registerPath(root, "implicit").catch(() => {
    /* best-effort */
  });
}

/**
 * Walk up from `p` looking for a watchlist entry whose path is an ancestor.
 * Returns the registered ancestor path if found, otherwise the resolved input
 * path unchanged. Bounded at 50 levels to avoid pathological symlink loops.
 */
export function resolveToRegisteredRoot(p: string): string {
  const resolved = path.resolve(p);
  let current = resolved;
  for (let i = 0; i < 50; i++) {
    if (watchlist.has(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return resolved;
}
