// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import type { AsyncSubscription } from "@parcel/watcher";
import watcher from "@parcel/watcher";
import { logger } from "../services/logger.js";
import { worktreeNameFromHeadPath } from "./git-state.js";

const subscriptions = new Map<string, AsyncSubscription>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 500;

export interface HeadWatcherOptions {
  onHeadChanged: (worktreeName: string) => void;
}

/**
 * Start a fs-watcher on <commonDir> that fires onHeadChanged when HEAD or
 * a worktree's HEAD changes. Ignores most of the .git internals (objects/,
 * refs/, etc.) to avoid noise, but keeps HEAD and worktrees/* visible.
 *
 * Idempotent: a second call on the same commonDir is a no-op.
 */
export async function startHeadWatcher(commonDir: string, opts: HeadWatcherOptions): Promise<void> {
  // Canonicalize: parcel-watcher reports event paths through fs.realpath
  // (e.g. /private/var/... on macOS), so we must subscribe + key with the
  // realpath form for path.relative() to produce a clean "HEAD".
  const canonicalCommonDir = (() => {
    try {
      return fs.realpathSync(commonDir);
    } catch {
      return commonDir;
    }
  })();
  if (subscriptions.has(canonicalCommonDir)) return;

  const subscription = await watcher.subscribe(
    canonicalCommonDir,
    (err, events) => {
      if (err) {
        logger.warn("head-watcher error", {
          commonDir: canonicalCommonDir,
          error: err.message,
        });
        return;
      }
      for (const ev of events) {
        // 1) HEAD-file events → debounced onHeadChanged
        const wt = worktreeNameFromHeadPath(canonicalCommonDir, ev.path);
        if (wt !== null) {
          const key = `${canonicalCommonDir}:${wt}`;
          const existing = debounceTimers.get(key);
          if (existing) clearTimeout(existing);
          debounceTimers.set(
            key,
            setTimeout(() => {
              debounceTimers.delete(key);
              try {
                opts.onHeadChanged(wt);
              } catch (handlerErr) {
                logger.error("onHeadChanged handler threw", {
                  commonDir: canonicalCommonDir,
                  worktree: wt,
                  error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
                });
              }
            }, DEBOUNCE_MS),
          );
          continue;
        }

        // 2) worktrees/<name>/ directory create/delete → log only (phase 8 GC)
        const rel = path.relative(canonicalCommonDir, ev.path);
        const m = /^worktrees[/\\]([^/\\]+)[/\\]?$/.exec(rel);
        if (m) {
          if (ev.type === "create") {
            logger.info("new linked worktree detected", { commonDir: canonicalCommonDir, name: m[1] });
          } else if (ev.type === "delete") {
            logger.info("linked worktree removed", { commonDir: canonicalCommonDir, name: m[1] });
          }
        }
      }
    },
    {
      // We can't watch a strictly-narrowed glob with parcel-watcher; instead we
      // subscribe to the entire common-dir and ignore the noisy subdirs. The
      // event filter above narrows to HEAD files + worktrees/<name>/.
      ignore: ["objects", "refs", "logs", "hooks", "info", "lfs", "index", "packed-refs"],
    },
  );

  subscriptions.set(canonicalCommonDir, subscription);
  logger.info("head-watcher started", { commonDir: canonicalCommonDir });
}

export async function stopHeadWatcher(commonDir: string): Promise<void> {
  // Accept either canonical or original form; map through realpath where possible.
  const canonical = (() => {
    try {
      return fs.realpathSync(commonDir);
    } catch {
      return commonDir;
    }
  })();
  const sub = subscriptions.get(canonical) ?? subscriptions.get(commonDir);
  const key = subscriptions.has(canonical) ? canonical : commonDir;
  if (!sub) return;
  await sub.unsubscribe();
  subscriptions.delete(key);
  for (const [k, t] of debounceTimers) {
    if (k.startsWith(`${key}:`)) {
      clearTimeout(t);
      debounceTimers.delete(k);
    }
  }
  logger.info("head-watcher stopped", { commonDir: key });
}

export async function stopAllHeadWatchers(): Promise<void> {
  for (const cd of Array.from(subscriptions.keys())) {
    await stopHeadWatcher(cd);
  }
}
