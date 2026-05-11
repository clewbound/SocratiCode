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

import fs from "node:fs";
import path from "node:path";
import { sanitizeBranchName } from "../config.js";
import { logger } from "../services/logger.js";
import { deleteCollection, getClient } from "../services/qdrant.js";
import { batchGetMarkedDeadAt, clearMarkedDeadAt, setMarkedDeadAt } from "./qdrant-meta.js";
import { watchlist } from "./watchlist.js";

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
    /^(codebase_|codegraph_|context_)?([A-Za-z0-9_-]+?)(?:__([A-Za-z0-9_-]+?))?(_symgraph_(?:meta|file|index))?$/.exec(
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
 * Parse `git for-each-ref --format=%(refname:short)` stdout into the set of
 * live branch names *in the same domain* as `parseCollectionName` output —
 * i.e. with `sanitizeBranchName` applied so a branch `dion/foo` matches the
 * `dion_foo` suffix that appears inside collection names.
 *
 * Strips `origin/` prefixes so a remote-tracking ref and its local
 * counterpart collapse to one entry.
 *
 * Exported for unit testing. Retained for the rare fallback callsite; the
 * primary live-branch source is {@link readLiveBranchesFromGitDir}.
 */
export function parseLiveBranchesFromGit(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(/^origin\//, "");
    const sanitized = sanitizeBranchName(stripped);
    if (sanitized) out.add(sanitized);
  }
  return out;
}

function walkRefs(rootDir: string, prefix: string, out: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .DS_Store etc.
    if (!prefix && e.name === "HEAD") continue; // remotes/origin/HEAD symref
    const sub = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkRefs(path.join(rootDir, e.name), sub, out);
    } else if (e.isFile()) {
      const sanitized = sanitizeBranchName(sub);
      if (sanitized) out.add(sanitized);
    }
  }
}

/**
 * Build the live-branch set directly from `<commonDir>/refs/heads/**`,
 * `<commonDir>/refs/remotes/origin/**`, and `<commonDir>/packed-refs`.
 *
 * Output parity with `git for-each-ref --format=%(refname:short) refs/heads
 * refs/remotes/origin` after the same `origin/` strip + `sanitizeBranchName`
 * transform applied by {@link parseLiveBranchesFromGit}. Skips dotfiles and
 * the `refs/remotes/origin/HEAD` symref to match git's filtering.
 *
 * Exported for unit testing.
 */
export function readLiveBranchesFromGitDir(commonDir: string): Set<string> {
  const out = new Set<string>();

  // Loose refs.
  walkRefs(path.join(commonDir, "refs", "heads"), "", out);
  const originDir = path.join(commonDir, "refs", "remotes", "origin");
  const originRefs = new Set<string>();
  walkRefs(originDir, "", originRefs);
  for (const r of originRefs) out.add(r); // already sanitized, no origin/ prefix in our walk

  // packed-refs: `<sha> <refname>` per line. Skip header (#) and peel (^) lines.
  const packed = path.join(commonDir, "packed-refs");
  let content: string;
  try {
    content = fs.readFileSync(packed, "utf-8");
  } catch {
    return out;
  }
  const HEADS = "refs/heads/";
  const ORIGIN = "refs/remotes/origin/";
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const ref = line.slice(sp + 1).trim();
    let name: string | null = null;
    if (ref.startsWith(HEADS)) name = ref.slice(HEADS.length);
    else if (ref.startsWith(ORIGIN)) {
      const tail = ref.slice(ORIGIN.length);
      if (tail !== "HEAD") name = tail;
    }
    if (name == null) continue;
    const sanitized = sanitizeBranchName(name);
    if (sanitized) out.add(sanitized);
  }
  return out;
}

/**
 * Build a {repoId → Set<branchName>} map from the watchlist.
 *
 * For each unique repoId with a non-null commonDir, read refs directly from
 * the .git layout (loose + packed). If reading throws unexpectedly the repo
 * is omitted — callers see `undefined` and skip GC for that repo entirely
 * (fail-open per spec §5).
 */
function collectLiveBranchesPerRepo(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of watchlist.entries()) {
    if (!entry.commonDir) continue;
    if (out.has(entry.repoId)) continue;
    try {
      out.set(entry.repoId, readLiveBranchesFromGitDir(entry.commonDir));
    } catch (err) {
      logger.warn("readLiveBranchesFromGitDir threw; skipping repo for collection GC", {
        repoId: entry.repoId,
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
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
  const liveByRepo = collectLiveBranchesPerRepo();
  const qdrant = getClient();
  const { collections } = await qdrant.getCollections().catch(() => ({
    collections: [] as Array<{ name: string }>,
  }));

  // Single batched retrieve over every collection's metadata point — one RTT
  // for the whole sweep instead of N. Missing or unreadable entries surface
  // as null in the map, identical to the per-call behavior of getMarkedDeadAt.
  const markedDeadByName = await batchGetMarkedDeadAt(collections.map((c) => c.name));

  for (const c of collections) {
    report.scanned += 1;
    const parsed = parseCollectionName(c.name);
    if (!parsed) continue;
    const liveSet = liveByRepo.get(parsed.repoId);
    if (!liveSet) continue; // unknown repoId — leave alone (fail-open)

    const isLive = parsed.branch != null && liveSet.has(parsed.branch);
    const markedAt = markedDeadByName.get(c.name) ?? null;

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
