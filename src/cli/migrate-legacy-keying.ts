// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Migrate legacy <pathhash>__<branch> collections to <repoId>__<branch>.
 * Standalone CLI; no daemon dependency.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRepoId } from "../config.js";
import {
  cloneCollectionPoints,
  getClient,
  getProjectMetadata,
  deleteCollection as qdrantDeleteCollection,
} from "../services/qdrant.js";

function stateDir(): string {
  if (process.env.SOCRATICODE_STATE_DIR) {
    return process.env.SOCRATICODE_STATE_DIR;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "socraticode");
  }
  return path.join(os.homedir(), ".local", "state", "socraticode");
}

const MARKER = "migration-v1.done";

export function isMigrationCompleted(): boolean {
  return fs.existsSync(path.join(stateDir(), MARKER));
}

export function markMigrationCompleted(): void {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARKER), `${new Date().toISOString()}\n`, "utf-8");
}

export interface LegacyCollection {
  /** Full qdrant collection name */
  name: string;
  /** Recorded project path from metadata (null if metadata is missing/corrupt) */
  path: string | null;
  /** Recorded branch from metadata (or extracted from name suffix) */
  branch: string | null;
}

export interface MigrationPlan {
  renames: Array<{ from: string; to: string }>;
  skipped: Array<{ name: string; reason: "target-exists" }>;
  unresolved: Array<{ name: string; reason: "no-path-metadata" | "no-repo-id" }>;
}

export function planMigration(args: {
  legacy: LegacyCollection[];
  repoIdByPath: Map<string, string>;
  existing: Set<string>;
}): MigrationPlan {
  const { legacy, repoIdByPath, existing } = args;
  const renames: MigrationPlan["renames"] = [];
  const skipped: MigrationPlan["skipped"] = [];
  const unresolved: MigrationPlan["unresolved"] = [];

  for (const c of legacy) {
    if (c.path == null) {
      unresolved.push({ name: c.name, reason: "no-path-metadata" });
      continue;
    }
    const repoId = repoIdByPath.get(c.path);
    if (!repoId) {
      unresolved.push({ name: c.name, reason: "no-repo-id" });
      continue;
    }
    const newName = renamedCollection(c.name, repoId);
    if (newName === c.name) continue; // already in new form
    if (existing.has(newName)) {
      skipped.push({ name: c.name, reason: "target-exists" });
      continue;
    }
    renames.push({ from: c.name, to: newName });
  }

  return { renames, skipped, unresolved };
}

export interface QdrantPort {
  listCollections(): Promise<string[]>;
  getMetadata(collectionName: string): Promise<{ path?: string; branch?: string } | null>;
  cloneCollection(from: string, to: string): Promise<void>;
  deleteCollection(name: string): Promise<void>;
}

const LEGACY_NAME_RE =
  /^(codebase_|codegraph_|context_)?[0-9a-f]{12}(__[A-Za-z0-9_-]+)?(_symgraph_(?:meta|file|index))?$/;

/** Extract a branch suffix from a legacy name when present. */
function branchFromName(name: string): string | null {
  const m = LEGACY_NAME_RE.exec(name);
  if (!m) return null;
  const suffix = m[2];
  if (!suffix) return null;
  return suffix.replace(/^__/, "");
}

export async function discoverLegacyCollections(port: QdrantPort): Promise<LegacyCollection[]> {
  const all = await port.listCollections();
  const candidates = all.filter((n) => LEGACY_NAME_RE.test(n));
  const out: LegacyCollection[] = [];
  for (const name of candidates) {
    const md = await port.getMetadata(name).catch(() => null);
    out.push({
      name,
      path: md?.path ?? null,
      branch: md?.branch ?? branchFromName(name),
    });
  }
  return out;
}

export function buildRepoIdMap(legacy: LegacyCollection[]): Map<string, string> {
  const out = new Map<string, string>();
  const paths = new Set<string>();
  for (const c of legacy) {
    if (c.path) paths.add(c.path);
  }
  for (const p of paths) {
    try {
      out.set(p, resolveRepoId(p));
    } catch {
      // path resolution failed (e.g., directory deleted) — skip; planner will mark as unresolved
    }
  }
  return out;
}

export interface ExecuteOptions {
  dryRun?: boolean;
}

export interface ExecuteSummary {
  succeeded: number;
  skipped: number;
  unresolved: number;
  failed: Array<{ from: string; to: string; error: string }>;
}

export async function executePlan(
  port: QdrantPort,
  plan: MigrationPlan,
  opts: ExecuteOptions = {},
): Promise<ExecuteSummary> {
  const summary: ExecuteSummary = {
    succeeded: 0,
    skipped: plan.skipped.length,
    unresolved: plan.unresolved.length,
    failed: [],
  };
  if (opts.dryRun) return summary;

  for (const r of plan.renames) {
    try {
      await port.cloneCollection(r.from, r.to);
    } catch (err) {
      summary.failed.push({
        from: r.from,
        to: r.to,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    try {
      await port.deleteCollection(r.from);
      summary.succeeded += 1;
    } catch (err) {
      summary.failed.push({
        from: r.from,
        to: r.to,
        error: `clone OK but delete failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return summary;
}

export async function runMigration(opts: { dryRun?: boolean } = {}): Promise<{
  plan: MigrationPlan;
  summary: ExecuteSummary;
}> {
  const port = realQdrantPort();
  const all = await port.listCollections();
  const existing = new Set(all);
  const legacy = await discoverLegacyCollections(port);
  const repoIdByPath = buildRepoIdMap(legacy);
  const plan = planMigration({ legacy, repoIdByPath, existing });
  const summary = await executePlan(port, plan, opts);
  return { plan, summary };
}

function formatPlan(plan: MigrationPlan): string {
  const lines = [
    `Migration plan:`,
    `  renames: ${plan.renames.length}`,
    `  skipped (target exists): ${plan.skipped.length}`,
    `  unresolved: ${plan.unresolved.length}`,
    "",
  ];
  for (const r of plan.renames) lines.push(`  RENAME ${r.from} -> ${r.to}`);
  for (const s of plan.skipped) lines.push(`  SKIP   ${s.name} (${s.reason})`);
  for (const u of plan.unresolved) lines.push(`  UNRES  ${u.name} (${u.reason})`);
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");

  if (!force && !dryRun && isMigrationCompleted()) {
    process.stdout.write(
      `Migration already completed (marker exists at ${path.join(stateDir(), MARKER)}).\n` +
        `Use --force to re-run, or --dry-run to inspect the current plan.\n`,
    );
    return 0;
  }

  const { plan, summary } = await runMigration({ dryRun });
  process.stdout.write(`${formatPlan(plan)}\n`);
  if (dryRun) {
    process.stdout.write("(dry-run: no changes made)\n");
    return 0;
  }
  process.stdout.write(
    `\nResult: ${summary.succeeded} renamed, ${summary.skipped} skipped, ${summary.unresolved} unresolved, ${summary.failed.length} failed\n`,
  );
  for (const f of summary.failed) {
    process.stderr.write(`FAILED ${f.from} -> ${f.to}: ${f.error}\n`);
  }
  if (summary.failed.length === 0) {
    markMigrationCompleted();
    return 0;
  }
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

/**
 * Build a `QdrantPort` backed by the real Qdrant service. Reads
 * `projectPath` from `getProjectMetadata` (branch is not stored on metadata
 * points so it's recovered from the collection name suffix in
 * {@link discoverLegacyCollections}).
 */
export function realQdrantPort(): QdrantPort {
  return {
    async listCollections() {
      const client = getClient();
      const { collections } = await client.getCollections();
      return collections.map((c) => c.name);
    },
    async getMetadata(name) {
      const md = await getProjectMetadata(name);
      if (!md) return null;
      return { path: md.projectPath };
    },
    async cloneCollection(from, to) {
      await cloneCollectionPoints(from, to);
    },
    async deleteCollection(name) {
      await qdrantDeleteCollection(name);
    },
  };
}

/**
 * Rewrite a collection name's pathhash prefix to the repo-id.
 * Handles all four name shapes:
 *   codebase_<hash>[__branch]
 *   codegraph_<hash>[__branch]
 *   context_<hash>[__branch]
 *   <hash>[__branch]_symgraph_(meta|file|index)
 */
export function renamedCollection(legacyName: string, repoId: string): string {
  const PREFIX_RE = /^(codebase_|codegraph_|context_)([0-9a-f]{12})(.*)$/;
  const SYMGRAPH_RE = /^([0-9a-f]{12})(__[A-Za-z0-9_-]+)?(_symgraph_(?:meta|file|index))$/;
  let m = PREFIX_RE.exec(legacyName);
  if (m) return `${m[1]}${repoId}${m[3]}`;
  m = SYMGRAPH_RE.exec(legacyName);
  if (m) return `${repoId}${m[2] ?? ""}${m[3]}`;
  return legacyName;
}
