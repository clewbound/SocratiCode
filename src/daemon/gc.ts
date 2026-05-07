// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * GC stubs for the daemon admin surface.
 *
 * These are intentional no-ops so phase 7's admin endpoints can compile and
 * answer requests with a well-formed (empty) plan. Phase 8 will replace both
 * functions with the real two-step sweeps:
 *
 *   - `runWatchlistGc`: prune watchlist entries whose path no longer exists or
 *     whose `lastQueriedAt` is past the inactivity TTL (sticky/explicit
 *     entries are exempt).
 *   - `runCollectionGc`: drop Qdrant collections that no longer correspond to
 *     any watched (repo, branch) pair.
 *
 * Until phase 8 lands, callers receive `{ removed: [], kept: 0 }` for both
 * sweeps, which is a valid plan (nothing to do). The `dryRun` flag is accepted
 * but ignored for now.
 */

export interface GcReport {
  removed: string[];
  kept: number;
}

export async function runWatchlistGc(_opts: { dryRun?: boolean }): Promise<GcReport> {
  return { removed: [], kept: 0 };
}

export async function runCollectionGc(_opts: { dryRun?: boolean }): Promise<GcReport> {
  return { removed: [], kept: 0 };
}
