// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import { cleanupStaleLocks } from "../services/lock.js";
import { logger } from "../services/logger.js";
import { gracefulShutdown } from "../services/startup.js";
import { startWatching } from "../services/watcher.js";
import { runCollectionGc, runWatchlistGc } from "./gc.js";
import { defaultHeadChangeHandler } from "./head-handler.js";
import { startHeadWatcher } from "./head-watcher.js";
import { detectLegacyCollections } from "./legacy-detect.js";
import { type DaemonServerHandle, startDaemonServer } from "./server.js";
import { watchlist } from "./watchlist.js";

const GC_INTERVAL_HOURS = Number.parseInt(
  process.env.SOCRATICODE_GC_INTERVAL_HOURS ?? "24",
  10,
);

export async function main(): Promise<number> {
  // Make the process easy to find in `ps aux | grep socraticode`.
  process.title = "socraticode-daemon";

  // Implies repo-keying for projectIdFromPath
  process.env.SOCRATICODE_DAEMON_MODE = "true";

  // Reclaim lock files orphaned by a previous daemon crash.
  await cleanupStaleLocks();

  let handle: DaemonServerHandle;
  try {
    handle = await startDaemonServer();
  } catch (err) {
    logger.error("Daemon failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }

  // Fire-and-forget: scan for legacy collections; one-line log if found
  detectLegacyCollections().catch((err) => {
    logger.debug("legacy-collection detection skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Filled in by phase 4 (watchlist) and phase 5 (HEAD watcher).
  await initWatchlist(); // re-arm persisted watchers
  await initHeadWatcher(); // start HEAD-flip watchers per repo

  // Phase 8: schedule periodic GC sweeps + run one immediately so a freshly
  // started daemon reconciles state without waiting a full interval.
  const gcTimer = await startGcSchedule();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Daemon shutting down", { signal });
    clearInterval(gcTimer);
    await gracefulShutdown(signal, async () => {
      await handle.close();
    });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection (daemon)", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // Keep the event loop alive
  return await new Promise(() => 0);
}

/** Re-arm persisted file watchers from the on-disk watchlist. Exported for testing. */
export async function initWatchlist(): Promise<void> {
  watchlist.load();
  for (const entry of watchlist.entries()) {
    if (!fs.existsSync(entry.path)) {
      logger.warn("watchlist entry path no longer exists, will GC", { path: entry.path });
      continue; // GC sweep (phase 8) handles removal
    }
    await startWatching(entry.path, undefined, () => watchlist.touch(entry.path)).catch((err) => {
      logger.error("failed to re-arm watcher on startup", {
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  logger.info("watchlist initialized", { count: watchlist.entries().length });
}

/**
 * Start one HEAD-flip watcher per unique commonDir referenced by the watchlist.
 * The handler ({@link defaultHeadChangeHandler}) decides whether to reindex
 * based on transient-marker presence and detached-HEAD state.
 */
async function initHeadWatcher(): Promise<void> {
  const seen = new Set<string>();
  for (const entry of watchlist.entries()) {
    if (!entry.commonDir || seen.has(entry.commonDir)) continue;
    seen.add(entry.commonDir);
    try {
      await startHeadWatcher(entry.commonDir, {
        onHeadChanged: defaultHeadChangeHandler(entry.commonDir),
      });
    } catch (err) {
      // Spec §9: HEAD-watcher failures are degraded-mode, not fatal. The
      // file-watcher fallback in src/services/watcher.ts will opportunistically
      // detect branch flips on file events.
      logger.warn("HEAD watcher failed to start (degraded mode)", {
        commonDir: entry.commonDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info("HEAD watchers initialized", { count: seen.size });
}

/**
 * Run watchlist + collection GC once on startup, then every
 * `SOCRATICODE_GC_INTERVAL_HOURS` (default 24h). Errors inside the periodic
 * tick are logged but never propagated — the timer must keep firing so a
 * single transient Qdrant blip doesn't stall GC indefinitely.
 *
 * Returns the timer handle so the shutdown path can clear it.
 */
async function startGcSchedule(): Promise<NodeJS.Timeout> {
  // Best-effort startup sweep. Don't let GC failure prevent the daemon from
  // serving requests — log and move on; the next periodic tick will retry.
  try {
    await runWatchlistGc({ dryRun: false });
    await runCollectionGc({ dryRun: false });
  } catch (err) {
    logger.error("startup GC failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const intervalMs = GC_INTERVAL_HOURS * 60 * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      await runWatchlistGc({ dryRun: false });
      await runCollectionGc({ dryRun: false });
    } catch (err) {
      logger.error("periodic GC failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);
  // unref so an idle GC timer doesn't keep the event loop alive on its own.
  timer.unref();
  logger.info("GC schedule armed", { intervalHours: GC_INTERVAL_HOURS });
  return timer;
}
