// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import { cleanupStaleLocks } from "../services/lock.js";
import { logger } from "../services/logger.js";
import { gracefulShutdown } from "../services/startup.js";
import { startWatching } from "../services/watcher.js";
import { defaultHeadChangeHandler } from "./head-handler.js";
import { startHeadWatcher } from "./head-watcher.js";
import { detectLegacyCollections } from "./legacy-detect.js";
import { type DaemonServerHandle, startDaemonServer } from "./server.js";
import { watchlist } from "./watchlist.js";

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

  // Filled in by the watchlist and HEAD watcher initializers below.
  await initWatchlist(); // re-arm persisted watchers
  await initHeadWatcher(); // start HEAD-flip watchers per repo

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Daemon shutting down", { signal });
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

/** Re-arm persisted file watchers from the on-disk watchlist. */
async function initWatchlist(): Promise<void> {
  watchlist.load();
  for (const entry of watchlist.entries()) {
    if (!fs.existsSync(entry.path)) {
      logger.warn("watchlist entry path no longer exists, will GC", { path: entry.path });
      continue; // GC sweep handles removal
    }
    await startWatching(entry.path).catch((err) => {
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
      // HEAD-watcher failures are degraded-mode, not fatal. The
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
