// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Two-step garbage collection for daemon-managed state.
 *
 *   - `runWatchlistGc`: prune watchlist entries whose path no longer exists or
 *     whose `lastQueriedAt` is past the inactivity TTL (sticky/explicit
 *     entries are exempt from inactivity GC; missing-on-disk drops them too).
 *   - `runCollectionGc`: drop Qdrant collections that no longer correspond to
 *     a live branch in any tracked repo. Uses a two-step `markedDeadAt`
 *     protocol: the first sweep marks dead collections, the second sweep
 *     deletes after a grace period. State is persisted on the per-collection
 *     metadata point in the shared metadata collection so the protocol
 *     survives daemon restarts and tolerates branch resurrection.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { logger } from "../services/logger.js";
import { deleteCollection, getClient } from "../services/qdrant.js";
import { clearMarkedDeadAt, getMarkedDeadAt, setMarkedDeadAt } from "./qdrant-meta.js";
import { watchlist } from "./watchlist.js";

const execFileP = promisify(execFile);

const INACTIVITY_DAYS = Number.parseInt(
  process.env.SOCRATICODE_GC_INACTIVITY_DAYS ?? "14",
  10,
);
const GRACE_DAYS = Number.parseInt(process.env.SOCRATICODE_GC_GRACE_DAYS ?? "7", 10);
const DETACHED_GRACE_DAYS = 1;

// ── Watchlist GC ─────────────────────────────────────────────────────────

export interface WatchlistGcReport {
  scanned: number;
  removed: Array<{
    path: string;
    reason: "inactive" | "missing-on-disk" | "broken-repo-id";
  }>;
}

export async function runWatchlistGc(opts: {
  dryRun: boolean;
}): Promise<WatchlistGcReport> {
  const report: WatchlistGcReport = { scanned: 0, removed: [] };
  const cutoff = Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of watchlist.entries()) {
    report.scanned += 1;
    if (!fs.existsSync(entry.path)) {
      report.removed.push({ path: entry.path, reason: "missing-on-disk" });
      if (!opts.dryRun) watchlist.remove(entry.path);
      continue;
    }
    if (entry.addedVia !== "implicit") continue; // sticky/explicit are immune
    const last = Date.parse(entry.lastQueriedAt);
    if (Number.isFinite(last) && last < cutoff) {
      report.removed.push({ path: entry.path, reason: "inactive" });
      if (!opts.dryRun) watchlist.remove(entry.path);
    }
  }
  if (report.removed.length > 0) {
    logger.info(
      `watchlist GC ${opts.dryRun ? "(dry-run) " : ""}removed ${report.removed.length} entries`,
      { report },
    );
  }
  return report;
}

// ── Collection GC ────────────────────────────────────────────────────────

export interface CollectionGcReport {
  scanned: number;
  marked: Array<{ name: string }>;
  cleared: Array<{ name: string }>;
  deleted: Array<{ name: string }>;
  failed: Array<{ name: string; error: string }>;
}

interface ParsedName {
  prefix: "codebase_" | "codegraph_" | "context_" | "" /* symgraph */;
  repoId: string;
  branch: string | null;
  detached: boolean;
}

/**
 * Parse a Qdrant collection name into its repo + branch parts.
 *
 * The regex is intentionally permissive: it can match unrelated names. The
 * downstream live-set lookup (`liveByRepo.get(parsed.repoId)`) is what filters
 * out collections that don't belong to any tracked repo — we never delete on
 * incomplete information, so unknown repoIds short-circuit to "leave alone".
 *
 * Exported for unit testing.
 */
export function parseCollectionName(name: string): ParsedName | null {
  // Matches: <prefix?><repoId>[__<branch>][_symgraph_(meta|file|index)]?
  const m =
    /^(codebase_|codegraph_|context_)?([A-Za-z0-9_-]+?)(?:__([A-Za-z0-9_-]+))?(_symgraph_(?:meta|file|index))?$/.exec(
      name,
    );
  if (!m) return null;
  const prefix = (m[1] ?? "") as ParsedName["prefix"];
  const repoId = m[2] ?? "";
  const branch = m[3] ?? null;
  if (!repoId) return null;
  return {
    prefix,
    repoId,
    branch,
    detached: branch?.startsWith("detached_") ?? false,
  };
}

/**
 * Build a {repoId → Set<branchName>} map from the watchlist.
 *
 * For each unique repoId with a non-null commonDir, run `git for-each-ref`
 * once and stash the resulting live-branch set. If `git for-each-ref` fails
 * for a repo (transient I/O, missing git binary, corrupted refs, etc.), that
 * repo is *omitted* from the map — callers see `undefined` and skip GC for
 * that repo entirely (fail-open per spec §5).
 */
async function collectLiveBranchesPerRepo(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const entry of watchlist.entries()) {
    if (!entry.commonDir) continue;
    if (out.has(entry.repoId)) continue;
    try {
      const { stdout } = await execFileP(
        "git",
        [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes/origin",
        ],
        { cwd: entry.path, timeout: 5000 },
      );
      const branches = new Set<string>();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Strip "origin/" prefix from remote refs so a remote `origin/main`
        // and a local `main` are treated as the same live branch.
        branches.add(trimmed.replace(/^origin\//, ""));
      }
      out.set(entry.repoId, branches);
    } catch (err) {
      logger.warn("git for-each-ref failed; skipping repo for collection GC", {
        repoId: entry.repoId,
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't fall through — refusing to GC on incomplete info.
    }
  }
  return out;
}

export async function runCollectionGc(opts: {
  dryRun: boolean;
}): Promise<CollectionGcReport> {
  const report: CollectionGcReport = {
    scanned: 0,
    marked: [],
    cleared: [],
    deleted: [],
    failed: [],
  };
  const liveByRepo = await collectLiveBranchesPerRepo();
  const qdrant = getClient();
  const { collections } = await qdrant.getCollections().catch(() => ({
    collections: [] as Array<{ name: string }>,
  }));

  for (const c of collections) {
    report.scanned += 1;
    const parsed = parseCollectionName(c.name);
    if (!parsed) continue;
    const liveSet = liveByRepo.get(parsed.repoId);
    if (!liveSet) continue; // unknown repoId — leave alone (fail-open)

    const isLive = parsed.branch != null && liveSet.has(parsed.branch);
    const markedAt = await getMarkedDeadAt(c.name).catch(() => null);

    if (isLive) {
      // Branch resurrection: clear any stale `markedDeadAt` so the next
      // sweep doesn't re-evaluate this collection as dead.
      if (markedAt != null) {
        if (!opts.dryRun) {
          await clearMarkedDeadAt(c.name).catch((err) => {
            logger.warn("clearMarkedDeadAt failed (best-effort)", {
              name: c.name,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        report.cleared.push({ name: c.name });
      }
      continue;
    }

    if (markedAt == null) {
      // First sweep: mark dead.
      if (opts.dryRun) {
        report.marked.push({ name: c.name });
      } else {
        try {
          await setMarkedDeadAt(c.name, Date.now());
          report.marked.push({ name: c.name });
        } catch (err) {
          report.failed.push({
            name: c.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    // Second sweep: check grace period.
    const graceDays = parsed.detached ? DETACHED_GRACE_DAYS : GRACE_DAYS;
    const ageMs = Date.now() - markedAt;
    if (ageMs >= graceDays * 24 * 60 * 60 * 1000) {
      if (opts.dryRun) {
        report.deleted.push({ name: c.name });
      } else {
        try {
          await deleteCollection(c.name);
          report.deleted.push({ name: c.name });
        } catch (err) {
          report.failed.push({
            name: c.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  if (report.deleted.length > 0 || report.failed.length > 0) {
    logger.info(
      `collection GC ${opts.dryRun ? "(dry-run) " : ""}deleted=${report.deleted.length} failed=${report.failed.length}`,
    );
  }
  return report;
}
