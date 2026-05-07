// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { logger } from "../services/logger.js";
import { gracefulShutdown } from "../services/startup.js";
import { detectLegacyCollections } from "./legacy-detect.js";
import { type DaemonServerHandle, startDaemonServer } from "./server.js";

export async function main(): Promise<number> {
  // Make the process easy to find in `ps aux | grep socraticode`.
  process.title = "socraticode-daemon";

  // Implies repo-keying for projectIdFromPath
  process.env.SOCRATICODE_DAEMON_MODE = "true";

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

/** Stub. Phase 4 will re-arm persisted file watchers from a watchlist on disk. */
async function initWatchlist(): Promise<void> {
  // phase 4
}

/** Stub. Phase 5 will start a per-repo HEAD-flip watcher to swap branch
 *  collections when the user checks out a different branch. */
async function initHeadWatcher(): Promise<void> {
  // phase 5
}
