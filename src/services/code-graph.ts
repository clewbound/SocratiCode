// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Lang, registerDynamicLanguage } from "@ast-grep/napi";
import { graphCollectionName, projectIdFromPath } from "../config.js";
import { EXTRA_EXTENSIONS, getLanguageFromExtension, MAX_GRAPH_FILE_BYTES } from "../constants.js";
import type {
  CodeGraph, CodeGraphEdge, CodeGraphNode,
  SymbolEdge, SymbolGraphFilePayload, SymbolGraphMeta, SymbolNode, SymbolRef,
} from "../types.js";
import { loadPathAliases } from "./graph-aliases.js";
import { extractImports } from "./graph-imports.js";
import { buildCsNamespaceMap, buildJvmSuffixMap, resolveImport } from "./graph-resolution.js";
import { computeUnresolvedPct, resolveCallSites } from "./graph-symbol-resolution.js";
import { extractSymbolsAndCalls, rawCallsToUnresolvedEdges } from "./graph-symbols.js";
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
    const built = await buildCodeGraph(resolvedPath, opts.extraExtensions, progress);
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

export function ensureDynamicLanguages(): void {
  if (dynamicLangsRegistered) return;
  dynamicLangsRegistered = true;

  try {
    const langModules: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {};

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
    ];

    for (const [name, pkg] of langPackages) {
      try {
        langModules[name] = esmRequire(pkg);
      } catch {
        // Language grammar not installed — skip silently
        logger.debug(`ast-grep language not available: ${name}`);
      }
    }

    if (Object.keys(langModules).length > 0) {
      registerDynamicLanguage(langModules);
      logger.info("Registered dynamic ast-grep languages", {
        languages: Object.keys(langModules),
      });
    }
  } catch (err) {
    logger.warn("Failed to register dynamic ast-grep languages", { error: String(err) });
  }
}

// ── Language mapping for ast-grep ────────────────────────────────────────

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
async function getGraphableFiles(
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
      const relPath = path.relative(projectPath, fullPath);

      if (shouldIgnore(ig, relPath)) continue;

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
 */
export async function buildCodeGraph(
  projectPath: string,
  extraExtensions?: Set<string>,
  progress?: GraphBuildProgress,
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

    let source: string;
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_GRAPH_FILE_BYTES) continue; // Skip large files
      source = await fs.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    // Create node for this file
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

    // Extract imports using ast-grep
    const importInfos = extractImports(source, lang, ext);

    // Hash the source once now — `persistSymbolGraph` consumes this map so
    // it can skip re-reading every file just to compute SHA-256.
    contentHashByFile.set(relPath, contentHashOf(source));

    // Extract symbols & raw call sites in the same pass
    try {
      const extracted = extractSymbolsAndCalls(source, lang, ext, relPath);
      symbolsByFile.set(relPath, extracted.symbols);
      outgoingCallsByFile.set(relPath, rawCallsToUnresolvedEdges(extracted.rawCalls));
    } catch (err) {
      logger.debug("Symbol extraction failed (continuing)", {
        file: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    for (const imp of importInfos) {
      node.imports.push(imp.moduleSpecifier);

      // Try to resolve to a project file
      // CSS imports from <style> blocks use CSS resolution even when the source file is Svelte/Vue
      const resolutionLanguage = imp.isCssImport ? "css" : language;
      const resolved = resolveImport(imp.moduleSpecifier, absolutePath, resolvedPath, fileSet, resolutionLanguage, aliases, jvmSuffixMap, csNamespaceMap);
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

  logger.info("Code graph built", { nodes: nodesMap.size, edges: edges.length });

  return {
    nodes: Array.from(nodesMap.values()),
    edges,
    symbolsByFile,
    outgoingCallsByFile,
    contentHashByFile,
  };
}
