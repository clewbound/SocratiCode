// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Lang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import { graphCollectionName, projectIdFromPath } from "../config.js";
import { EXTRA_EXTENSIONS, getLanguageFromExtension, MAX_GRAPH_FILE_BYTES, toForwardSlash } from "../constants.js";
import type {
  CodeGraph, CodeGraphEdge, CodeGraphNode,
  SymbolEdge, SymbolGraphFilePayload, SymbolGraphMeta, SymbolNode, SymbolRef,
} from "../types.js";
import { loadPathAliases } from "./graph-aliases.js";
import { extractImports } from "./graph-imports.js";
import { buildCsNamespaceMap, buildGoModuleInfo, buildJvmSuffixMap, resolveImport } from "./graph-resolution.js";
import { computeUnresolvedPct, resolveCallSites } from "./graph-symbol-resolution.js";
import { type ExtractedSymbols, extractSymbolsAndCalls, rawCallsToUnresolvedEdges } from "./graph-symbols.js";
import { createIgnoreFilter, shouldIgnore } from "./ignore.js";
import { logger } from "./logger.js";
import {
  deleteGraphData,
  getGraphMetadata,
  loadGraphData,
  loadGraphGitBlobShas,
  saveGraphData,
} from "./qdrant.js";
import {
  type CachedSymbolEntry,
  lookupSymbolCacheBatch,
  symbolCacheKey,
  writeSymbolCacheBatch,
} from "./symbol-cache.js";
import {
  dropSymbolGraphCache,
  SymbolGraphCache,
  setSymbolGraphCache,
} from "./symbol-graph-cache.js";
import {
  allNameShardKeys,
  contentHashOf,
  deleteSymbolGraphData,
  ensureSymbolGraphCollections,
  nameShardKey,
  reverseShardKey,
  saveFilePayloads,
  saveNameShard,
  saveReverseShard,
  saveSymbolGraphMeta,
} from "./symbol-graph-store.js";

// Re-export analysis functions for external consumers
export { findCircularDependencies, generateMermaidDiagram, getFileDependencies, getGraphStats } from "./graph-analysis.js";

// createRequire needed to load native addon packages in ESM
const esmRequire = createRequire(import.meta.url);

// ── Graph build progress tracking ────────────────────────────────────────

/** Progress details for an in-flight graph build operation */
export interface GraphBuildProgress {
  startedAt: number;       // Date.now()
  filesTotal: number;
  filesProcessed: number;
  phase: string;           // "scanning files" | "analyzing imports" | "persisting"
  error?: string;
}

/** Summary of a completed graph build operation */
export interface GraphBuildCompleted {
  completedAt: number;     // Date.now()
  durationMs: number;
  filesProcessed: number;
  nodesCreated: number;
  edgesCreated: number;
  error?: string;
}

/** Track which projects currently have a graph build in flight */
const graphBuildInProgress = new Map<string, GraphBuildProgress>();

/** In-flight build promises — allows callers to share a single build */
const graphBuildPromises = new Map<string, Promise<CodeGraph>>();

/** Track the last completed graph build per project */
const lastGraphBuildCompleted = new Map<string, GraphBuildCompleted>();

/** Check if a graph build is currently in progress for a project */
export function isGraphBuildInProgress(projectPath: string): boolean {
  return graphBuildInProgress.has(path.resolve(projectPath));
}

/** Get progress details for a graph build currently in progress */
export function getGraphBuildProgress(projectPath: string): GraphBuildProgress | null {
  return graphBuildInProgress.get(path.resolve(projectPath)) ?? null;
}

/** Get the last completed graph build for a project */
export function getLastGraphBuildCompleted(projectPath: string): GraphBuildCompleted | null {
  return lastGraphBuildCompleted.get(path.resolve(projectPath)) ?? null;
}

/** Get all projects currently building a graph */
export function getGraphBuildInProgressProjects(): string[] {
  return Array.from(graphBuildInProgress.keys());
}

// ── Graph cache (service-level, shared by tools and watcher) ─────────────

/** In-memory graph cache keyed by resolved project path */
const graphCache = new Map<string, CodeGraph>();

/** Invalidate graph cache for a project (called by watcher on file changes) */
export function invalidateGraphCache(projectPath: string): void {
  graphCache.delete(path.resolve(projectPath));
}

/** Get a cached graph, or load from Qdrant, or build one */
export async function getOrBuildGraph(
  projectPath: string,
  extraExtensions?: Set<string>,
): Promise<CodeGraph> {
  const resolved = path.resolve(projectPath);
  const cached = graphCache.get(resolved);
  if (cached) {
    return cached;
  }

  // Try loading persisted graph from Qdrant
  const projectId = projectIdFromPath(resolved);
  const graphCollName = graphCollectionName(projectId);
  const persisted = await loadGraphData(graphCollName);
  if (persisted) {
    graphCache.set(resolved, persisted);
    return persisted;
  }

  const graph = await buildCodeGraph(resolved, extraExtensions);
  // Strip symbol fields when serving as a plain CodeGraph
  const plain: CodeGraph = { nodes: graph.nodes, edges: graph.edges };
  graphCache.set(resolved, plain);
  return plain;
}

/** Options for `rebuildGraph` controlling which layers are rebuilt. */
export interface RebuildGraphOptions {
  /** Extra file extensions to treat as graph nodes. */
  extraExtensions?: Set<string>;
  /**
   * When `true`, skip the symbol-graph extraction + persistence step entirely.
   * The file-import graph is still rebuilt and persisted. The caller is then
   * expected to update the symbol graph incrementally via
   * `updateChangedFilesSymbolGraph` from `symbol-graph-incremental.ts`.
   * Default: `false`.
   */
  skipSymbolGraph?: boolean;
  /**
   * Map of repo-relative path → git blob SHA-1 for the working tree the graph
   * is being built from. When provided, persisted on the codegraph metadata
   * point so future runs can take the same-tree freshness fast-path via
   * {@link isGraphFresh}.
   */
  gitBlobShas?: Map<string, string>;
}

/** Compare two `gitBlobShas` maps for exact equality (same keys, same values).
 *  When they differ, logs a sample of the divergence so callers can diagnose
 *  freshness-gate misses without re-running with extra instrumentation. */
function shasEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) {
    logger.info("isGraphFresh: size mismatch", { stored: a.size, current: b.size });
    return false;
  }
  let mismatches = 0;
  let missingInB = 0;
  const sampleStoredOnly: string[] = [];
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv === undefined) {
      missingInB++;
      if (sampleStoredOnly.length < 3) sampleStoredOnly.push(k);
    } else if (bv !== v) {
      mismatches++;
    }
  }
  if (mismatches === 0 && missingInB === 0) return true;
  logger.info("isGraphFresh: content mismatch", {
    storedSize: a.size,
    currentSize: b.size,
    valueMismatches: mismatches,
    keysMissingInCurrent: missingInB,
    sampleStoredOnly,
  });
  return false;
}

/** Returns true when the persisted codegraph was built from the same git
 *  tree (`gitBlobShas`) as `currentShas`. Lets callers skip a 100s+
 *  `rebuildGraph` whenever the working tree hasn't moved since the last
 *  successful build (e.g. same-branch reindex, sibling-clone after Part B
 *  copies the codegraph metadata point).
 *
 *  Returns `false` when no codegraph metadata exists, when the persisted
 *  shas are missing/malformed, or when any path or sha differs. */
export async function isGraphFresh(
  projectPath: string,
  currentShas: Map<string, string>,
): Promise<boolean> {
  const projectId = projectIdFromPath(projectPath);
  const graphCollName = graphCollectionName(projectId);
  const stored = await loadGraphGitBlobShas(graphCollName).catch((err) => {
    logger.warn("isGraphFresh: loadGraphGitBlobShas threw", {
      graphCollName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (stored === null) {
    logger.info("isGraphFresh: no stored gitBlobShas (cold codegraph)", { graphCollName });
    return false;
  }
  return shasEqual(stored, currentShas);
}

/** Force-rebuild, cache, and persist a graph.
 * If a build is already in progress for this project, returns the existing
 * in-flight promise (deduplication — same as indexer concurrency guard).
 *
 * Backward-compatible: accepts either `extraExtensions` (legacy positional
 * Set) or a `RebuildGraphOptions` object.
 */
export async function rebuildGraph(
  projectPath: string,
  optsOrExtras?: Set<string> | RebuildGraphOptions,
): Promise<CodeGraph> {
  const resolved = path.resolve(projectPath);
  const opts: RebuildGraphOptions =
    optsOrExtras instanceof Set ? { extraExtensions: optsOrExtras } : (optsOrExtras ?? {});

  // Concurrency guard: if already building, return the existing promise
  const existing = graphBuildPromises.get(resolved);
  if (existing) {
    logger.info("Graph build already in progress, joining existing build", { projectPath: resolved });
    return existing;
  }

  // Start tracked build
  const promise = doRebuildGraph(resolved, opts);
  graphBuildPromises.set(resolved, promise);

  try {
    const graph = await promise;
    return graph;
  } finally {
    graphBuildPromises.delete(resolved);
  }
}

/** Internal: performs the actual graph rebuild with progress tracking */
async function doRebuildGraph(
  resolvedPath: string,
  opts: RebuildGraphOptions,
): Promise<CodeGraph> {
  const progress: GraphBuildProgress = {
    startedAt: Date.now(),
    filesTotal: 0,
    filesProcessed: 0,
    phase: "scanning files",
  };
  graphBuildInProgress.set(resolvedPath, progress);

  try {
    graphCache.delete(resolvedPath);
    const built = await buildCodeGraph(resolvedPath, opts.extraExtensions, progress, opts.gitBlobShas);
    const graph: CodeGraph = { nodes: built.nodes, edges: built.edges };
    graphCache.set(resolvedPath, graph);

    // Persist file-import graph to Qdrant
    progress.phase = "persisting";
    const projectId = projectIdFromPath(resolvedPath);
    const graphCollName = graphCollectionName(projectId);
    await saveGraphData(graphCollName, resolvedPath, graph, {
      gitBlobShas: opts.gitBlobShas,
    });

    // Build & persist symbol graph (resolution + sharded persistence) — unless
    // the caller asked to skip it (Phase F watcher path).
    if (!opts.skipSymbolGraph) {
      try {
        progress.phase = "resolving symbols";
        resolveCallSites(graph, built.symbolsByFile, built.outgoingCallsByFile);

        progress.phase = "persisting symbols";
        await persistSymbolGraph(
          projectId,
          built.symbolsByFile,
          built.outgoingCallsByFile,
          built.contentHashByFile,
        );
      } catch (err) {
        logger.warn("Symbol graph build failed (file-import graph saved)", {
          projectPath: resolvedPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    lastGraphBuildCompleted.set(resolvedPath, {
      completedAt: Date.now(),
      durationMs: Date.now() - progress.startedAt,
      filesProcessed: progress.filesProcessed,
      nodesCreated: graph.nodes.length,
      edgesCreated: graph.edges.length,
    });

    return graph;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.error = message;
    lastGraphBuildCompleted.set(resolvedPath, {
      completedAt: Date.now(),
      durationMs: Date.now() - progress.startedAt,
      filesProcessed: progress.filesProcessed,
      nodesCreated: 0,
      edgesCreated: 0,
      error: message,
    });
    throw err;
  } finally {
    graphBuildInProgress.delete(resolvedPath);
  }
}

/** Persist the symbol graph: per-file payloads + sharded indices + meta.
 *
 * `contentHashByFile` is computed by `buildCodeGraph` during the in-memory
 * parse pass (the source string is already in scope there), so this function
 * never re-reads files from disk. Missing entries fall back to an empty hash
 * — matches the prior behaviour for files whose source could not be read. */
async function persistSymbolGraph(
  projectId: string,
  symbolsByFile: Map<string, SymbolNode[]>,
  outgoingCallsByFile: Map<string, SymbolEdge[]>,
  contentHashByFile: Map<string, string>,
): Promise<void> {
  await ensureSymbolGraphCollections(projectId);

  // Build per-file payloads — `contentHash` was computed during the in-memory
  // parse pass; no third I/O pass needed here.
  const payloads: SymbolGraphFilePayload[] = [];
  let totalSymbols = 0;
  let totalEdges = 0;
  for (const [relPath, symbols] of symbolsByFile.entries()) {
    const outgoingCalls = outgoingCallsByFile.get(relPath) ?? [];
    let language = "plaintext";
    const firstNonModule = symbols.find((s) => s.name !== "<module>");
    if (firstNonModule) language = firstNonModule.language;
    else language = symbols[0]?.language ?? language;

    const contentHash = contentHashByFile.get(relPath) ?? "";
    payloads.push({
      file: relPath, language, contentHash, symbols, outgoingCalls,
    });
    totalSymbols += symbols.filter((s) => s.name !== "<module>").length;
    totalEdges += outgoingCalls.length;
  }

  // Build sharded indices
  const nameShards = new Map<string, Record<string, SymbolRef[]>>();
  for (const key of allNameShardKeys()) nameShards.set(key, {});
  for (const [file, symbols] of symbolsByFile.entries()) {
    for (const sym of symbols) {
      if (sym.name === "<module>") continue;
      const shardKey = nameShardKey(sym.name);
      const shard = nameShards.get(shardKey);
      if (!shard) continue;
      const ref: SymbolRef = { file, id: sym.id };
      // Use hasOwn — `shard[sym.name]` would return Object.prototype.constructor
      // (a function) for symbol names like "constructor" / "toString" / "hasOwnProperty".
      const existing = Object.hasOwn(shard, sym.name) ? shard[sym.name] : undefined;
      if (existing) existing.push(ref);
      else shard[sym.name] = [ref];
    }
  }

  const reverseShards = new Map<number, Record<string, string[]>>();
  for (const [callerFile, edges] of outgoingCallsByFile.entries()) {
    for (const e of edges) {
      for (const calleeId of e.calleeCandidates) {
        const calleeFile = calleeId.split("::")[0];
        if (!calleeFile || calleeFile === callerFile) continue;
        const bucket = reverseShardKey(calleeFile);
        let shard = reverseShards.get(bucket);
        if (!shard) {
          shard = {};
          reverseShards.set(bucket, shard);
        }
        const existing = shard[calleeFile];
        if (existing) {
          if (!existing.includes(callerFile)) existing.push(callerFile);
        } else {
          shard[calleeFile] = [callerFile];
        }
      }
    }
  }

  // Persist. Shards are small in count (≤27 name + ≤256 reverse) and each
  // upsert is an independent Qdrant RPC, so fire them in parallel —
  // serialising them gave up several seconds of wall time on large repos.
  await saveFilePayloads(projectId, payloads);

  const nameShardSaves: Promise<void>[] = [];
  for (const [shardKey, shard] of nameShards.entries()) {
    if (Object.keys(shard).length === 0) continue;
    nameShardSaves.push(saveNameShard(projectId, shardKey, shard));
  }
  const reverseShardSaves: Promise<void>[] = [];
  for (const [bucket, shard] of reverseShards.entries()) {
    if (Object.keys(shard).length === 0) continue;
    reverseShardSaves.push(saveReverseShard(projectId, bucket, shard));
  }
  await Promise.all([...nameShardSaves, ...reverseShardSaves]);

  const meta: SymbolGraphMeta = {
    projectId,
    symbolCount: totalSymbols,
    edgeCount: totalEdges,
    fileCount: symbolsByFile.size,
    unresolvedEdgePct: computeUnresolvedPct(outgoingCallsByFile),
    builtAt: Date.now(),
    schemaVersion: 1,
  };
  await saveSymbolGraphMeta(projectId, meta);

  // Replace cache entry
  const cache = new SymbolGraphCache(projectId, meta);
  setSymbolGraphCache(cache);

  logger.info("Symbol graph persisted", {
    projectId,
    files: meta.fileCount,
    symbols: meta.symbolCount,
    edges: meta.edgeCount,
    unresolvedPct: meta.unresolvedEdgePct.toFixed(1),
  });
}

/**
 * Wait for any in-flight graph build to finish for a project.
 * Resolves immediately if no build is in progress.
 * Swallows errors — the caller typically wants to proceed regardless.
 */
export async function awaitGraphBuild(projectPath: string): Promise<void> {
  const resolved = path.resolve(projectPath);
  const promise = graphBuildPromises.get(resolved);
  if (promise) {
    try { await promise; } catch { /* swallow — caller proceeds regardless */ }
  }
}

/** Remove a persisted code graph from Qdrant and clear cache */
export async function removeGraph(projectPath: string): Promise<void> {
  const resolved = path.resolve(projectPath);
  graphCache.delete(resolved);
  const projectId = projectIdFromPath(resolved);
  const graphCollName = graphCollectionName(projectId);
  await deleteGraphData(graphCollName);
  await deleteSymbolGraphData(projectId);
  dropSymbolGraphCache(projectId);
  logger.info("Removed code graph", { projectPath: resolved });
}

/** Check if a graph exists (in cache or persisted) */
export async function hasGraph(projectPath: string): Promise<boolean> {
  const resolved = path.resolve(projectPath);
  if (graphCache.has(resolved)) return true;
  const projectId = projectIdFromPath(resolved);
  const graphCollName = graphCollectionName(projectId);
  const meta = await getGraphMetadata(graphCollName);
  return meta !== null;
}

/** Get graph metadata for status display */
export async function getGraphStatus(projectPath: string): Promise<{
  lastBuiltAt: string;
  nodeCount: number;
  edgeCount: number;
  cached: boolean;
  symbol?: {
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    unresolvedEdgePct: number;
    builtAt: number;
  };
} | null> {
  const resolved = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolved);
  const graphCollName = graphCollectionName(projectId);
  const meta = await getGraphMetadata(graphCollName);
  if (!meta) return null;

  // Best-effort symbol-graph stats
  let symbol: {
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    unresolvedEdgePct: number;
    builtAt: number;
  } | undefined;
  try {
    const { loadSymbolGraphMeta } = await import("./symbol-graph-store.js");
    const sm = await loadSymbolGraphMeta(projectId);
    if (sm) {
      symbol = {
        fileCount: sm.fileCount,
        symbolCount: sm.symbolCount,
        edgeCount: sm.edgeCount,
        unresolvedEdgePct: sm.unresolvedEdgePct,
        builtAt: sm.builtAt,
      };
    }
  } catch {
    // symbol graph optional
  }
  return {
    lastBuiltAt: meta.lastBuiltAt,
    nodeCount: meta.nodeCount,
    edgeCount: meta.edgeCount,
    cached: graphCache.has(resolved),
    symbol,
  };
}

// ── Register dynamic language grammars ───────────────────────────────────

let dynamicLangsRegistered = false;
const loadedDynamicLanguages = new Set<string>();
const failedDynamicLanguages = new Map<string, string>();

/** Module export shape exposed by `@ast-grep/lang-*` packages. */
interface AstGrepLangModule {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
}

/** Snapshot of dynamic-language registration state, for diagnostics. */
export interface DynamicLanguageStatus {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
}

/** Returns which dynamic ast-grep grammars registered successfully and which failed. */
export function getDynamicLanguageStatus(): DynamicLanguageStatus {
  return {
    loaded: [...loadedDynamicLanguages].sort(),
    failed: [...failedDynamicLanguages.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, error]) => ({ name, error })),
  };
}

export function ensureDynamicLanguages(): void {
  if (dynamicLangsRegistered) return;
  dynamicLangsRegistered = true;

  try {
    const survivors: Record<string, AstGrepLangModule> = {};

    const langPackages: Array<[string, string]> = [
      ["python",  "@ast-grep/lang-python"],
      ["go",      "@ast-grep/lang-go"],
      ["java",    "@ast-grep/lang-java"],
      ["rust",    "@ast-grep/lang-rust"],
      ["c",       "@ast-grep/lang-c"],
      ["cpp",     "@ast-grep/lang-cpp"],
      ["csharp",  "@ast-grep/lang-csharp"],
      ["ruby",    "@ast-grep/lang-ruby"],
      ["kotlin",  "@ast-grep/lang-kotlin"],
      ["swift",   "@ast-grep/lang-swift"],
      ["scala",   "@ast-grep/lang-scala"],
      ["bash",    "@ast-grep/lang-bash"],
      ["php",     "@ast-grep/lang-php"],
      ["lua",     "@ast-grep/lang-lua"],
      ["dart",    "@ast-grep/lang-dart"],
    ];

    for (const [name, pkg] of langPackages) {
      try {
        const mod = esmRequire(pkg) as AstGrepLangModule;
        // Pre-validate the lazy `libraryPath` getter. `registerDynamicLanguage`
        // accesses this property for every entry it receives, and a single
        // throwing getter aborts the entire batch atomically (issue #43).
        // Touching the getter here, inside the per-grammar try/catch, isolates
        // a missing-prebuild failure to that one grammar so the rest can still
        // be registered. The getter caches its result inside the package, so
        // this is not duplicated work.
        void mod.libraryPath;
        survivors[name] = mod;
        loadedDynamicLanguages.add(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedDynamicLanguages.set(name, message);
        logger.warn("ast-grep grammar failed to load", { name, error: message });
      }
    }

    if (Object.keys(survivors).length > 0) {
      registerDynamicLanguage(survivors);
      logger.info("Registered dynamic ast-grep languages", {
        languages: [...loadedDynamicLanguages].sort(),
      });
    } else {
      logger.warn(
        "No dynamic ast-grep grammars loaded; PHP, Python, JVM and other dynamic languages will fall through to <module>-only extraction",
      );
    }
    if (failedDynamicLanguages.size > 0) {
      logger.warn(
        "Some dynamic ast-grep grammars failed to load; affected languages will produce only <module>-level symbols",
        { failed: [...failedDynamicLanguages.keys()].sort() },
      );
    }
  } catch (err) {
    // Should be unreachable now that each grammar is validated independently,
    // but keep the outer guard so an unexpected throw cannot take the indexer
    // process down.
    logger.warn("Unexpected error in ensureDynamicLanguages", { error: String(err) });
  }
}

// ── Language mapping for ast-grep ────────────────────────────────────────

/** Languages where `extractImports` and `extractSymbolsAndCalls` both AST-parse
 *  the same source with the same ast-grep `Lang`. For these we can parse once
 *  upstream and pass the root to both extractors, halving parse work in the
 *  hot loop. Excludes:
 *   - Composite langs (svelte/vue) which need a separate HTML+TS parse pass.
 *   - Regex-only langs (dart/lua) which never call ast-grep.
 *   - CSS, where only `extractImports` runs (and only as regex over source);
 *     parsing upstream would just throw away work. */
const SHARED_PARSE_LANGS: ReadonlySet<Lang | string> = new Set<Lang | string>([
  Lang.JavaScript,
  Lang.TypeScript,
  Lang.Tsx,
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "c",
  "cpp",
  "ruby",
  "php",
  "swift",
  "bash",
]);

/** Map file extensions to ast-grep language identifiers */
export function getAstGrepLang(ext: string): Lang | string | null {
  const map: Record<string, Lang | string> = {
    // Dynamic languages (string identifiers)
    ".py": "python", ".pyw": "python", ".pyi": "python",
    ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin",
    ".scala": "scala",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".hh": "cpp", ".cxx": "cpp",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".dart": "dart",
    ".lua": "lua",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    // Composite languages (parsed via HTML + script re-parse)
    ".svelte": "svelte",
    ".vue": "vue",
    // Built-in languages (Lang enum)
    ".js": Lang.JavaScript, ".jsx": Lang.JavaScript, ".mjs": Lang.JavaScript, ".cjs": Lang.JavaScript,
    ".ts": Lang.TypeScript,
    ".tsx": Lang.Tsx,
    ".html": Lang.Html, ".htm": Lang.Html,
    ".css": Lang.Css, ".scss": Lang.Css, ".sass": Lang.Css, ".less": Lang.Css, ".styl": Lang.Css,
  };
  return map[ext] ?? null;
}

// ── Graph building ───────────────────────────────────────────────────────

/**
 * Get all source files in a project for graph analysis.
 * Includes files with known AST grammars and any extra extensions.
 */
export async function getGraphableFiles(
  projectPath: string,
  extraExts?: Set<string>,
): Promise<string[]> {
  const ig = createIgnoreFilter(projectPath);
  const extras = extraExts ?? EXTRA_EXTENSIONS;
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = toForwardSlash(path.relative(projectPath, fullPath));

      if (shouldIgnore(ig, entry.isDirectory() ? `${relPath}/` : relPath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Include if AST grammar is available OR if it's an extra extension
        if (getAstGrepLang(ext) !== null || extras.has(ext)) {
          files.push(relPath);
        }
      }
    }
  }

  await walk(projectPath);
  return files;
}

/**
 * Build a code graph for a project using ast-grep for polyglot support.
 * Files with extra extensions (no AST grammar) are included as leaf nodes
 * that can be targets of import edges from other files.
 *
 * Also extracts symbols and call sites in the same pass — returned via
 * `symbolsByFile` / `outgoingCallsByFile` and persisted by `doRebuildGraph`.
 *
 * `gitBlobShas` enables the global blob-sha-keyed parsed-symbol cache: any
 * file whose `(lang, blobSha)` is already in `socraticode_symbol_cache` skips
 * AST parsing entirely and reuses the cached extraction. Files without a
 * blob sha (untracked / not in the map) bypass the cache and parse normally.
 * Set `SOCRATICODE_SYMBOL_CACHE=0` to disable lookup+write entirely.
 */
export async function buildCodeGraph(
  projectPath: string,
  extraExtensions?: Set<string>,
  progress?: GraphBuildProgress,
  gitBlobShas?: Map<string, string>,
): Promise<CodeGraph & {
  symbolsByFile: Map<string, SymbolNode[]>;
  outgoingCallsByFile: Map<string, SymbolEdge[]>;
  /** SHA-256 of each file's source, computed during the parse pass so
   *  `persistSymbolGraph` does not have to re-read every file from disk. */
  contentHashByFile: Map<string, string>;
}> {
  ensureDynamicLanguages();

  const resolvedPath = path.resolve(projectPath);
  const aliases = await loadPathAliases(resolvedPath);
  const files = await getGraphableFiles(resolvedPath, extraExtensions);
  const fileSet = new Set(files);

  if (progress) {
    progress.filesTotal = files.length;
    progress.phase = "analyzing imports";
  }

  logger.info("Building code graph", { projectPath: resolvedPath, fileCount: files.length });

  const nodesMap = new Map<string, CodeGraphNode>();
  const edges: CodeGraphEdge[] = [];
  const symbolsByFile = new Map<string, SymbolNode[]>();
  const outgoingCallsByFile = new Map<string, SymbolEdge[]>();
  // Hash each file's source once during the parse pass — `persistSymbolGraph`
  // reads from this map instead of re-opening every file from disk.
  const contentHashByFile = new Map<string, string>();

  // ── Symbol cache: batch lookup for any file we have a blob sha for ────
  // Content-addressed by `(lang, blobSha)` so identical blobs across branches
  // and projects share extraction work. Skipped entirely when the env opt-out
  // is set or when no blob shas are available (e.g. non-git working trees).
  const symbolCacheEnabled =
    process.env.SOCRATICODE_SYMBOL_CACHE !== "0" && (gitBlobShas?.size ?? 0) > 0;

  // Map of relPath → cache key string so the parse loop can look up payloads
  // without recomputing the key (which depends on `lang` resolution).
  const cacheKeyByFile = new Map<string, string>();
  let cacheLookup = new Map<string, CachedSymbolEntry>();
  if (symbolCacheEnabled && gitBlobShas) {
    const lookupEntries: Array<{ lang: string; blobSha: string }> = [];
    for (const relPath of files) {
      const blobSha = gitBlobShas.get(relPath);
      if (!blobSha) continue;
      const ext = path.extname(relPath).toLowerCase();
      const lang = getAstGrepLang(ext);
      if (!lang) continue;
      const langKey = String(lang);
      const key = symbolCacheKey(langKey, blobSha);
      cacheKeyByFile.set(relPath, key);
      lookupEntries.push({ lang: langKey, blobSha });
    }
    if (lookupEntries.length > 0) {
      cacheLookup = await lookupSymbolCacheBatch(lookupEntries);
      logger.info("Symbol cache batch lookup", {
        candidates: lookupEntries.length,
        hits: cacheLookup.size,
        hitRatePct: ((cacheLookup.size / lookupEntries.length) * 100).toFixed(1),
      });
    }
  }
  // Queued cache writes — flushed at the end of the build, best-effort.
  const cacheWrites: CachedSymbolEntry[] = [];

  // Build a suffix lookup map for JVM multi-module projects (Java/Kotlin/Scala).
  // This resolves FQNs like com.example.Foo when the class lives under a nested
  // src/main/java/ tree (e.g. module-a/sub/src/main/java/com/example/Foo.java).
  // Cost: O(n) once here, O(1) per import lookup (negligible vs. full AST parse).
  const hasJvm = files.some((f) => {
    const e = path.extname(f).toLowerCase();
    return e === ".java" || e === ".kt" || e === ".kts" || e === ".scala";
  });
  const jvmSuffixMap = hasJvm ? buildJvmSuffixMap(fileSet) : undefined;

  // Build a namespace lookup map for C# projects. Each `namespace X.Y.Z` block
  // (or file-scoped `namespace X.Y.Z;`) is recorded so `using X.Y.Z;` directives
  // can be resolved to the file(s) that contribute to that namespace. Without
  // this, every C# import resolved to null and the file graph was empty.
  const hasCs = files.some((f) => path.extname(f).toLowerCase() === ".cs");
  const csNamespaceMap = hasCs ? buildCsNamespaceMap(fileSet, resolvedPath) : undefined;

  // Build Go module-resolution info from go.mod (issue #45). Without this,
  // every Go import resolved to null and Go projects produced an empty
  // file graph. The info is null when go.mod is missing or unparseable;
  // the resolver treats null as "no Go resolution available" and behaves
  // exactly as it did before this PR for those cases.
  const hasGo = files.some((f) => f.endsWith(".go"));
  const goModuleInfo = hasGo ? buildGoModuleInfo(fileSet, resolvedPath) : undefined;

  for (const relPath of files) {
    const ext = path.extname(relPath).toLowerCase();
    const lang = getAstGrepLang(ext);

    // Files with no AST grammar (extra extensions) are included as leaf nodes
    // so they can be targets of import edges from other files, but we skip
    // import extraction since we can't parse them.
    if (!lang) {
      const absolutePath = path.join(resolvedPath, relPath);
      if (!nodesMap.has(relPath)) {
        nodesMap.set(relPath, {
          filePath: absolutePath,
          relativePath: relPath,
          imports: [],
          exports: [],
          dependencies: [],
          dependents: [],
        });
      }
      if (progress) progress.filesProcessed++;
      continue;
    }

    const language = getLanguageFromExtension(ext);
    const absolutePath = path.join(resolvedPath, relPath);

    // Create node for this file (always — both cache-hit and miss paths need it)
    if (!nodesMap.has(relPath)) {
      nodesMap.set(relPath, {
        filePath: absolutePath,
        relativePath: relPath,
        imports: [],
        exports: [],
        dependencies: [],
        dependents: [],
      });
    }
    const node = nodesMap.get(relPath);
    if (!node) continue;

    // ── Cache-hit fast path ────────────────────────────────────────────
    // If we have a `(lang, blobSha)` hit, we can skip both file I/O and
    // ast-grep parse: the cached payload already contains symbols, raw
    // calls, and imports computed from this exact blob. We still recompute
    // the contentHash from the cached imports' source — but the cache key
    // is the blob SHA itself, which IS the content hash for git-tracked
    // files, so we reuse it directly without reading the file.
    const cacheKey = cacheKeyByFile.get(relPath);
    const cached = cacheKey ? cacheLookup.get(cacheKey) : undefined;
    if (cached) {
      // gitBlobShas is guaranteed defined here (we only seeded cacheKeyByFile
      // when it was populated) — but TypeScript can't prove it, so use `?.`.
      const blobSha = gitBlobShas?.get(relPath);
      if (blobSha) contentHashByFile.set(relPath, blobSha);
      symbolsByFile.set(relPath, cached.symbols);
      outgoingCallsByFile.set(relPath, rawCallsToUnresolvedEdges(cached.rawCalls));

      for (const imp of cached.imports) {
        node.imports.push(imp.moduleSpecifier);
        const resolutionLanguage = imp.isCssImport ? "css" : language;
        const resolved = resolveImport(imp.moduleSpecifier, absolutePath, resolvedPath, fileSet, resolutionLanguage, aliases, jvmSuffixMap, csNamespaceMap);
        if (resolved) {
          node.dependencies.push(resolved);
          if (!nodesMap.has(resolved)) {
            nodesMap.set(resolved, {
              filePath: path.join(resolvedPath, resolved),
              relativePath: resolved,
              imports: [],
              exports: [],
              dependencies: [],
              dependents: [],
            });
          }
          nodesMap.get(resolved)?.dependents.push(relPath);
          edges.push({
            source: relPath,
            target: resolved,
            type: imp.isDynamic ? "dynamic-import" : "import",
          });
        }
      }
      if (progress) progress.filesProcessed++;
      continue;
    }

    let source: string;
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_GRAPH_FILE_BYTES) continue; // Skip large files
      source = await fs.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    // Parse once per file when both extractors will use the same ast-grep
    // Lang. `extractImports` and `extractSymbolsAndCalls` accept the root and
    // skip their own internal parse. Composite (svelte/vue) and regex-only
    // (dart/lua) langs leave this `undefined` and let each extractor handle
    // its own parsing path.
    let parsedRoot: SgNode | undefined;
    if (SHARED_PARSE_LANGS.has(lang)) {
      try {
        parsedRoot = parse(lang, source).root();
      } catch (err) {
        // Fall through to extractor-internal parsing on failure — preserves
        // the original error-handling path (each extractor logs + recovers).
        logger.debug("Upstream parse failed, falling back to per-extractor parse", {
          file: relPath,
          lang: String(lang),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Extract imports using ast-grep
    const importInfos = extractImports(source, lang, ext, parsedRoot);

    // Hash the source once now — `persistSymbolGraph` consumes this map so
    // it can skip re-reading every file just to compute SHA-256.
    contentHashByFile.set(relPath, contentHashOf(source));

    // Extract symbols & raw call sites in the same pass
    let extractedRawCalls: ExtractedSymbols["rawCalls"] | null = null;
    let extractedSymbols: SymbolNode[] | null = null;
    try {
      const extracted = extractSymbolsAndCalls(source, lang, ext, relPath, parsedRoot);
      extractedSymbols = extracted.symbols;
      extractedRawCalls = extracted.rawCalls;
      symbolsByFile.set(relPath, extracted.symbols);
      outgoingCallsByFile.set(relPath, rawCallsToUnresolvedEdges(extracted.rawCalls));
    } catch (err) {
      logger.debug("Symbol extraction failed (continuing)", {
        file: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Queue this miss for batch cache write at end of build. Only enqueue
    // when we have a blob sha AND symbol extraction succeeded — otherwise
    // we'd cache a partial result that future hits would replay.
    if (symbolCacheEnabled && cacheKey && extractedSymbols !== null && extractedRawCalls !== null) {
      const blobSha = gitBlobShas?.get(relPath);
      const langKey = String(lang);
      if (blobSha) {
        cacheWrites.push({
          lang: langKey,
          blobSha,
          symbols: extractedSymbols,
          rawCalls: extractedRawCalls,
          imports: importInfos,
        });
      }
    }

    for (const imp of importInfos) {
      node.imports.push(imp.moduleSpecifier);

      // Try to resolve to a project file
      // CSS imports from <style> blocks use CSS resolution even when the source file is Svelte/Vue
      const resolutionLanguage = imp.isCssImport ? "css" : language;
      const resolved = resolveImport(imp.moduleSpecifier, absolutePath, resolvedPath, fileSet, resolutionLanguage, aliases, jvmSuffixMap, csNamespaceMap, goModuleInfo);
      if (resolved) {
        node.dependencies.push(resolved);

        // Ensure target node exists
        if (!nodesMap.has(resolved)) {
          nodesMap.set(resolved, {
            filePath: path.join(resolvedPath, resolved),
            relativePath: resolved,
            imports: [],
            exports: [],
            dependencies: [],
            dependents: [],
          });
        }
        nodesMap.get(resolved)?.dependents.push(relPath);

        edges.push({
          source: relPath,
          target: resolved,
          type: imp.isDynamic ? "dynamic-import" : "import",
        });
      }
    }

    if (progress) progress.filesProcessed++;
  }

  logger.info("Code graph built", {
    nodes: nodesMap.size,
    edges: edges.length,
    cacheHits: cacheLookup.size,
    cacheWrites: cacheWrites.length,
  });

  // Flush queued cache writes. Awaited so any test/benchmark that immediately
  // re-runs sees a populated cache; the upsert itself uses `wait: false` so
  // the round trip does not block on Qdrant durably persisting the points.
  // Best-effort: never throws (failures are logged and swallowed inside).
  if (cacheWrites.length > 0) {
    await writeSymbolCacheBatch(cacheWrites);
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges,
    symbolsByFile,
    outgoingCallsByFile,
    contentHashByFile,
  };
}
