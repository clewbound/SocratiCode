// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { type Lang, parse } from "@ast-grep/napi";
import { glob } from "glob";
import {
  collectionName,
  graphCollectionName,
  projectIdFromPath,
  symgraphFileCollectionName,
  symgraphIndexCollectionName,
  symgraphMetaCollectionName,
} from "../config.js";
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EXTRA_EXTENSIONS,
  getLanguageFromExtension,
  INDEX_BATCH_SIZE,
  MAX_AVG_LINE_LENGTH,
  MAX_CHUNK_CHARS,MAX_FILE_BYTES,
  SPECIAL_FILES,
  SUPPORTED_EXTENSIONS
} from "../constants.js";
import type { FileChunk } from "../types.js";
import {
  ensureDynamicLanguages,
  getAstGrepLang,
  invalidateGraphCache,
  isGraphFresh,
  rebuildGraph,
  removeGraph,
} from "./code-graph.js";
import { ensureArtifactsIndexed, loadConfig, removeAllArtifacts } from "./context-artifacts.js";
import { type CachedEmbedding, lookupEmbeddings, putEmbedding } from "./embedding-cache.js";
import { generateEmbeddings, prepareDocumentText } from "./embeddings.js";
import { diffGitTrees, getGitBlobShas } from "./git-tree.js";
import { createIgnoreFilter, shouldIgnore } from "./ignore.js";
import { acquireProjectLock, releaseProjectLock } from "./lock.js";
import { logger } from "./logger.js";
import {
  cloneCollectionPoints,
  cloneGraphMetadataPoint,
  deleteCollection,
  deleteFileChunks,
  deleteFileChunksBatch,
  deleteProjectMetadata,
  ensureCollection,
  findSiblingMetadata,
  getCollectionInfo,
  getProjectMetadata,
  loadProjectGitBlobShas,
  loadProjectHashes,
  replaceCollectionFromSibling,
  saveProjectMetadata,
  upsertPreEmbeddedChunks,
} from "./qdrant.js";
import { dropSymbolGraphCache } from "./symbol-graph-cache.js";
import { updateChangedFilesSymbolGraph } from "./symbol-graph-incremental.js";
import { loadSymbolGraphMeta } from "./symbol-graph-store.js";

const FILE_SCAN_BATCH = 50; // Number of files to scan/chunk in parallel (I/O only, no network)

/**
 * Phase F: maximum number of changed/removed files for which the watcher path
 * patches the symbol graph in-place rather than rebuilding it from scratch.
 * Above this threshold a full rebuild is faster than re-running per-file
 * extraction + shard merging, since most shards would be touched anyway.
 */
const INCREMENTAL_SYMBOL_THRESHOLD = 50;

/** State for tracking indexed files per project (loaded from Qdrant on first use) */
const projectHashes = new Map<string, Map<string, string>>();
const projectHashesLoaded = new Set<string>();

/** Progress details for an in-flight indexing operation */
export interface IndexingProgress {
  type: "full-index" | "incremental-update";
  startedAt: number;  // Date.now()
  filesTotal: number;
  filesProcessed: number;
  chunksTotal?: number;
  chunksProcessed?: number;
  /** Total number of file batches (each up to INDEX_BATCH_SIZE files) */
  batchesTotal?: number;
  /** Number of file batches fully processed and checkpointed */
  batchesProcessed?: number;
  phase: string;
  error?: string;
}

/** Summary of a completed indexing operation */
export interface IndexingCompleted {
  type: "full-index" | "incremental-update";
  completedAt: number;  // Date.now()
  durationMs: number;
  filesProcessed: number;
  chunksCreated: number;
  error?: string;
}

/** Track which projects currently have an indexing operation in flight */
const indexingInProgress = new Map<string, IndexingProgress>();

/** Track the last completed indexing operation per project */
const lastCompleted = new Map<string, IndexingCompleted>();

/** Cancellation requests — set to true to stop indexing at the next batch boundary */
const cancellationRequested = new Map<string, boolean>();

/** Check if a project is currently being indexed (full index or incremental update) */
export function isIndexingInProgress(projectPath: string): boolean {
  return indexingInProgress.has(path.resolve(projectPath));
}

/** Get progress details for a project currently being indexed */
export function getIndexingProgress(projectPath: string): IndexingProgress | null {
  return indexingInProgress.get(path.resolve(projectPath)) ?? null;
}

/** Set or clear progress for a project (used by index-tools during infrastructure setup) */
export function setIndexingProgress(projectPath: string, progress: IndexingProgress | null): void {
  const resolved = path.resolve(projectPath);
  if (progress) {
    indexingInProgress.set(resolved, progress);
  } else {
    indexingInProgress.delete(resolved);
  }
}

/** Get the last completed indexing operation for a project */
export function getLastCompleted(projectPath: string): IndexingCompleted | null {
  return lastCompleted.get(path.resolve(projectPath)) ?? null;
}

/** Get all projects currently being indexed */
export function getIndexingInProgressProjects(): string[] {
  return Array.from(indexingInProgress.keys());
}

/** Check if a project's index is complete by querying persisted metadata in Qdrant.
 *  Returns "completed", "in-progress", or "unknown" (no metadata found). */
export async function getPersistedIndexingStatus(projectPath: string): Promise<"completed" | "in-progress" | "unknown"> {
  const resolvedPath = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedPath);
  const collection = collectionName(projectId);
  const metadata = await getProjectMetadata(collection);
  if (!metadata) return "unknown";
  return metadata.indexingStatus;
}

/** Request graceful cancellation of an in-flight indexing operation.
 *  The operation will stop after the current batch finishes and checkpoint. */
export function requestCancellation(projectPath: string): boolean {
  const resolved = path.resolve(projectPath);
  if (!indexingInProgress.has(resolved)) return false;
  cancellationRequested.set(resolved, true);
  logger.info("Cancellation requested — will stop after current batch", { projectPath: resolved });
  return true;
}

/** Check whether cancellation has been requested for a project */
function isCancellationRequested(resolvedPath: string): boolean {
  return cancellationRequested.get(resolvedPath) === true;
}

async function getProjectHashes(projectId: string, collection: string, resolvedProjectPath?: string): Promise<Map<string, string>> {
  if (!projectHashes.has(projectId)) {
    // Try to load from Qdrant (persistent storage).
    // loadProjectHashes now throws on transient errors (instead of returning null),
    // so a Qdrant blip will propagate up rather than silently returning empty hashes
    // (which could cascade into a destructive clean-start).
    if (!projectHashesLoaded.has(projectId)) {
      projectHashesLoaded.add(projectId);
      const stored = await loadProjectHashes(collection);
      if (stored) {
        // Migrate absolute-path keys to relative paths (one-time, transparent).
        // Indexes built before the relative-path fix stored absolute paths as hash keys.
        const migrated = migrateAbsolutePathKeys(stored, resolvedProjectPath);
        logger.info("Loaded file hashes from Qdrant", { projectId, count: migrated.size, wasMigrated: migrated !== stored });
        projectHashes.set(projectId, migrated);
        return migrated;
      }
    }
    projectHashes.set(projectId, new Map());
  }
  return projectHashes.get(projectId) as Map<string, string>;
}

/**
 * Migrate hash map keys from absolute paths to relative paths.
 * Returns a new map if migration was needed, or the original map if keys are already relative.
 */
function migrateAbsolutePathKeys(hashes: Map<string, string>, resolvedProjectPath?: string): Map<string, string> {
  if (hashes.size === 0) return hashes;

  // Check if keys look like absolute paths
  const firstKey = hashes.keys().next().value as string;
  if (!firstKey.startsWith("/") && !firstKey.startsWith("\\")) return hashes;

  // Try to strip the stored project path prefix, or detect the common prefix
  const prefix = resolvedProjectPath
    ? `${resolvedProjectPath}/`
    : detectCommonPrefix(hashes);

  if (!prefix) {
    logger.warn("Hash keys appear absolute but could not determine prefix to strip — skipping migration");
    return hashes;
  }

  const migrated = new Map<string, string>();
  for (const [absPath, hash] of hashes) {
    const relative = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
    migrated.set(relative, hash);
  }

  logger.info("Migrated hash keys from absolute to relative paths", { count: migrated.size, prefix });
  return migrated;
}

/** Detect the longest common directory prefix across all hash keys */
function detectCommonPrefix(hashes: Map<string, string>): string | null {
  const keys = Array.from(hashes.keys());
  if (keys.length === 0) return null;

  let prefix = keys[0];
  for (let i = 1; i < keys.length; i++) {
    while (!keys[i].startsWith(prefix)) {
      const lastSlash = prefix.lastIndexOf("/");
      if (lastSlash <= 0) return null;
      prefix = prefix.slice(0, lastSlash + 1);
    }
  }

  // Ensure prefix ends with /
  if (!prefix.endsWith("/")) {
    const lastSlash = prefix.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    prefix = prefix.slice(0, lastSlash + 1);
  }

  return prefix;
}

/** Hash file content for change detection */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compares two gitBlobShas maps for exact equality (same paths, same shas).
 * Cheap O(n) check, n = file count. Used by the same-collection fast-skip
 * path to detect when a branch is unchanged since its last full index.
 */
function gitBlobShasEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [filePath, sha] of a) {
    if (b.get(filePath) !== sha) return false;
  }
  return true;
}

/** Generate a stable chunk ID as a valid UUID (required by Qdrant) */
export function chunkId(relativePath: string, startLine: number): string {
  const hash = createHash("sha256").update(`${relativePath}:${startLine}`).digest("hex").slice(0, 32);
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Check if a file should be indexed based on extension or name */
export function isIndexableFile(fileName: string, extraExts?: Set<string>): boolean {
  if (SPECIAL_FILES.has(fileName)) return true;
  const ext = path.extname(fileName).toLowerCase();
  if (SUPPORTED_EXTENSIONS.has(ext)) return true;
  // Check extra extensions (from env var + tool parameter)
  const extras = extraExts ?? EXTRA_EXTENSIONS;
  return extras.has(ext);
}

/** AST node kinds that represent top-level declarations per language */
const TOP_LEVEL_KINDS: Record<string, string[]> = {
  // JS/TS
  JavaScript: ["function_declaration", "class_declaration", "export_statement",
               "lexical_declaration", "variable_declaration", "expression_statement"],
  TypeScript: ["function_declaration", "class_declaration", "export_statement",
               "lexical_declaration", "variable_declaration", "interface_declaration",
               "type_alias_declaration", "enum_declaration", "expression_statement"],
  Tsx:        ["function_declaration", "class_declaration", "export_statement",
               "lexical_declaration", "variable_declaration", "interface_declaration",
               "type_alias_declaration", "enum_declaration", "expression_statement"],
  // Python
  python:     ["function_definition", "class_definition", "decorated_definition"],
  // Java / Kotlin / Scala
  java:       ["class_declaration", "interface_declaration", "enum_declaration", "method_declaration"],
  kotlin:     ["class_declaration", "function_declaration", "object_declaration"],
  scala:      ["class_definition", "object_definition", "trait_definition", "function_definition"],
  // C / C++
  c:          ["function_definition", "struct_specifier", "enum_specifier", "declaration"],
  cpp:        ["function_definition", "class_specifier", "struct_specifier", "namespace_definition", "declaration"],
  // Others
  csharp:     ["class_declaration", "interface_declaration", "method_declaration", "namespace_declaration"],
  go:         ["function_declaration", "method_declaration", "type_declaration"],
  rust:       ["function_item", "impl_item", "struct_item", "enum_item", "trait_item", "mod_item"],
  ruby:       ["method", "class", "module", "singleton_method"],
  php:        ["function_definition", "class_declaration", "method_declaration", "trait_declaration"],
  swift:      ["function_declaration", "class_declaration", "struct_declaration", "protocol_declaration", "extension_declaration"],
  bash:       ["function_definition"],
};

/** Minimum lines for a chunk to stand on its own (otherwise merge with neighbors) */
const MIN_CHUNK_LINES = 5;
/** Maximum lines for a single AST chunk before sub-chunking */
const MAX_CHUNK_LINES = 150;

interface AstRegion {
  startLine: number; // 0-based
  endLine: number;   // 0-based exclusive
}

/**
 * Use ast-grep to find top-level declaration boundaries in source code.
 * Returns sorted, non-overlapping regions.
 */
function findAstBoundaries(source: string, lang: Lang | string): AstRegion[] {
  const langKey = String(lang);
  const kinds = TOP_LEVEL_KINDS[langKey];
  if (!kinds) return [];

  try {
    const root = parse(lang, source).root();
    const regions: AstRegion[] = [];

    for (const kind of kinds) {
      for (const node of root.findAll({ rule: { kind } })) {
        const range = node.range();
        // Only top-level nodes (depth 1 from root, or depth 2 for namespace/module wrappers)
        const parent = node.parent();
        const grandparent = parent?.parent();
        const isTopLevel = !parent || parent.kind() === "program" || parent.kind() === "source_file"
          || parent.kind() === "translation_unit" || parent.kind() === "module"
          || parent.kind() === "export_statement" || parent.kind() === "decorated_definition"
          || parent.kind() === "compilation_unit"
          // Depth 2: e.g., class inside namespace
          || (grandparent && (grandparent.kind() === "program" || grandparent.kind() === "source_file"
            || grandparent.kind() === "translation_unit" || grandparent.kind() === "compilation_unit"));

        if (isTopLevel) {
          regions.push({ startLine: range.start.line, endLine: range.end.line + 1 });
        }
      }
    }

    // Sort by start line and merge overlapping regions
    regions.sort((a, b) => a.startLine - b.startLine);
    const merged: AstRegion[] = [];
    for (const r of regions) {
      const last = merged[merged.length - 1];
      if (last && r.startLine <= last.endLine) {
        last.endLine = Math.max(last.endLine, r.endLine);
      } else {
        merged.push({ ...r });
      }
    }

    return merged;
  } catch {
    return [];
  }
}

/**
 * Apply a hard character cap to every chunk as a universal safety net.
 * Any chunk whose content exceeds MAX_CHUNK_CHARS is truncated. This is
 * intentionally simple — the provider's pre-truncation is the last-resort
 * defence; this cap ensures chunks are already within bounds before that.
 */
function applyCharCap(chunks: FileChunk[]): FileChunk[] {
  if (chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)) return chunks;
  return chunks.map((c) =>
    c.content.length > MAX_CHUNK_CHARS
      ? { ...c, content: c.content.substring(0, MAX_CHUNK_CHARS) }
      : c,
  );
}

/**
 * Character-based chunking for minified/bundled content whose average line
 * length exceeds MAX_AVG_LINE_LENGTH. Splits at safe token boundaries
 * (newline, space, tab, semicolon, comma) so chunks stay within
 * MAX_CHUNK_CHARS without splitting mid-identifier.
 *
 * NOTE: The chunk `id` uses the byte offset as its discriminator (not the
 * line number) because minified files may consist of a single very long
 * line, making startLine identical across all chunks.
 */
function chunkByCharacters(
  filePath: string,
  relativePath: string,
  content: string,
  language: string,
): FileChunk[] {
  const chunks: FileChunk[] = [];
  let offset = 0;
  let currentLine = 1;

  while (offset < content.length) {
    let end = Math.min(offset + MAX_CHUNK_CHARS, content.length);

    // Scan backwards from the hard limit to find a safe split boundary.
    // If none is found within the window, fall through and split at the limit.
    if (end < content.length) {
      for (let i = end; i > offset; i--) {
        const ch = content[i];
        if (ch === "\n" || ch === " " || ch === "\t" || ch === ";" || ch === ",") {
          end = i + 1;
          break;
        }
      }
    }

    const chunkContent = content.slice(offset, end);
    const startLine = currentLine;
    const newlineCount = (chunkContent.match(/\n/g) ?? []).length;
    const endLine = startLine + newlineCount;

    chunks.push({
      id: chunkId(relativePath, offset), // byte offset → unique ID even for 1-line files
      filePath,
      relativePath,
      content: chunkContent,
      startLine,
      endLine,
      language,
      type: "code",
    });

    // Advance line counter: if the chunk ended with a newline the next
    // chunk starts on a new line; otherwise we're still on the same line.
    currentLine = chunkContent.endsWith("\n") ? endLine + 1 : endLine;
    offset = end;
  }

  return chunks;
}

/**
 * Split file content into chunks using AST-aware boundaries when possible.
 * Falls back to line-based chunking for unsupported languages or on parse
 * failure. Minified/bundled content (detected via average line length) is
 * handled by character-based chunking to avoid context-window overflows.
 * A hard character cap is applied to every chunk regardless of strategy.
 */
export function chunkFileContent(
  filePath: string,
  relativePath: string,
  content: string,
): FileChunk[] {
  const lines = content.split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const language = getLanguageFromExtension(ext);

  // Detect minified/bundled content before any other branching: a high
  // average line length means line-based chunks would be huge single lines
  // that overflow the embedding model's context window.
  const avgLineLength = lines.length > 0 ? content.length / lines.length : 0;
  if (avgLineLength > MAX_AVG_LINE_LENGTH) {
    logger.debug("Minified/bundled content detected — using character-based chunking", {
      relativePath,
      avgLineLength: Math.round(avgLineLength),
    });
    return applyCharCap(chunkByCharacters(filePath, relativePath, content, language));
  }

  // Small files: single chunk regardless of language
  if (lines.length <= CHUNK_SIZE) {
    return applyCharCap([{
      id: chunkId(relativePath, 1),
      filePath,
      relativePath,
      content,
      startLine: 1,
      endLine: lines.length,
      language,
      type: "code",
    }]);
  }

  // Try AST-aware chunking for supported languages
  const astLang = getAstGrepLang(ext);
  const regions = astLang ? findAstBoundaries(content, astLang) : [];

  if (regions.length > 0) {
    return applyCharCap(chunkByAstRegions(filePath, relativePath, lines, language, regions));
  }

  // Fallback: line-based chunking
  return applyCharCap(chunkByLines(filePath, relativePath, lines, language));
}

/**
 * Create chunks aligned to AST declaration boundaries.
 * Groups small declarations together; sub-chunks large ones.
 */
function chunkByAstRegions(
  filePath: string,
  relativePath: string,
  lines: string[],
  language: string,
  regions: AstRegion[],
): FileChunk[] {
  const chunks: FileChunk[] = [];

  // Preamble: everything before the first declaration (imports, constants, comments)
  if (regions[0].startLine > 0) {
    const preambleLines = lines.slice(0, regions[0].startLine);
    if (preambleLines.length > 0) {
      chunks.push({
        id: chunkId(relativePath, 1),
        filePath,
        relativePath,
        content: preambleLines.join("\n"),
        startLine: 1,
        endLine: regions[0].startLine,
        language,
        type: "code",
      });
    }
  }

  // Process each region, merging small ones, sub-chunking large ones
  let pendingStart = -1;
  let pendingEnd = -1;

  const flushPending = () => {
    if (pendingStart < 0) return;
    const regionLines = lines.slice(pendingStart, pendingEnd);
    const regionLength = regionLines.length;

    if (regionLength <= MAX_CHUNK_LINES) {
      chunks.push({
        id: chunkId(relativePath, pendingStart + 1),
        filePath,
        relativePath,
        content: regionLines.join("\n"),
        startLine: pendingStart + 1,
        endLine: pendingEnd,
        language,
        type: "code",
      });
    } else {
      // Sub-chunk large declarations with overlap
      for (let start = 0; start < regionLength; start += CHUNK_SIZE - CHUNK_OVERLAP) {
        const end = Math.min(start + CHUNK_SIZE, regionLength);
        chunks.push({
          id: chunkId(relativePath, pendingStart + start + 1),
          filePath,
          relativePath,
          content: regionLines.slice(start, end).join("\n"),
          startLine: pendingStart + start + 1,
          endLine: pendingStart + end,
          language,
          type: "code",
        });
        if (end >= regionLength) break;
      }
    }
    pendingStart = -1;
    pendingEnd = -1;
  };

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const regionLength = region.endLine - region.startLine;

    // Include gap lines between previous region end and this region start
    const gapStart = i === 0 ? regions[0].startLine : regions[i - 1].endLine;
    const effectiveStart = gapStart < region.startLine ? gapStart : region.startLine;

    if (pendingStart < 0) {
      // Start a new pending group
      pendingStart = effectiveStart;
      pendingEnd = region.endLine;
    } else {
      const combinedLength = region.endLine - pendingStart;
      if (combinedLength <= CHUNK_SIZE && regionLength < MIN_CHUNK_LINES) {
        // Merge small declaration into pending group
        pendingEnd = region.endLine;
      } else {
        // Flush previous group, start new one
        flushPending();
        pendingStart = effectiveStart;
        pendingEnd = region.endLine;
      }
    }
  }
  flushPending();

  // Epilogue: anything after the last declaration
  const lastEnd = regions[regions.length - 1].endLine;
  if (lastEnd < lines.length) {
    const epilogueLines = lines.slice(lastEnd);
    if (epilogueLines.length > 0) {
      chunks.push({
        id: chunkId(relativePath, lastEnd + 1),
        filePath,
        relativePath,
        content: epilogueLines.join("\n"),
        startLine: lastEnd + 1,
        endLine: lines.length,
        language,
        type: "code",
      });
    }
  }

  return chunks;
}

/**
 * Fallback line-based chunking with fixed overlap.
 */
function chunkByLines(
  filePath: string,
  relativePath: string,
  lines: string[],
  language: string,
): FileChunk[] {
  const chunks: FileChunk[] = [];

  for (let start = 0; start < lines.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_SIZE, lines.length);
    const chunkContent = lines.slice(start, end).join("\n");

    chunks.push({
      id: chunkId(relativePath, start + 1),
      filePath,
      relativePath,
      content: chunkContent,
      startLine: start + 1,
      endLine: end,
      language,
      type: "code",
    });

    if (end >= lines.length) break;
  }

  return chunks;
}

/** Get all indexable files in a project directory */
export async function getIndexableFiles(
  projectPath: string,
  extraExts?: Set<string>,
): Promise<string[]> {
  const ig = createIgnoreFilter(projectPath);

  const allFiles = await glob("**/*", {
    cwd: projectPath,
    nodir: true,
    dot: (process.env.INCLUDE_DOT_FILES ?? "false").toLowerCase() === "true",
    absolute: false,
  });

  return allFiles.filter((relativePath) => {
    const fileName = path.basename(relativePath);
    if (!isIndexableFile(fileName, extraExts)) return false;
    if (shouldIgnore(ig, relativePath)) return false;
    return true;
  });
}

/**
 * Internal options bag for {@link scanAndIndexFiles}. Captures everything the
 * scan + embed pipeline closes over; deliberately scoped to the minimum the
 * extracted body needs so future call sites (e.g. the sibling-clone fast path)
 * can drive the helper with a path subset without touching `indexProject`'s
 * outer setup.
 */
interface ScanAndIndexOptions {
  resolvedPath: string;
  collection: string;
  /** Mutated in-place: scan populates new entries, stale entries get removed. */
  hashes: Map<string, string>;
  /** Relative paths to scan + embed. Caller decides full set vs. subset. */
  targetFiles: string[];
  progress: IndexingProgress;
  onProgress?: (message: string) => void;
  hasExistingData: boolean;
  /** Set of files currently present + indexable in the working tree. Used by
   *  the cleanup loop to identify chunks for files genuinely removed from
   *  disk. Defaults to `new Set(targetFiles)` for backward compatibility with
   *  the full-project flow where targetFiles === all indexable files.
   *  The sibling-clone path passes the FULL set so that paths in `hashes`
   *  (seeded with diff.unchanged) aren't misidentified as deleted. */
  currentFileSet?: Set<string>;
}

/**
 * Pure refactor of the scan + embed pipeline previously inlined in
 * {@link indexProject}. Behavior is identical: the function consumes
 * `targetFiles`, scans + chunks, deletes stale chunks for changed/removed
 * files, embeds + upserts in batches, and persists in-progress checkpoints
 * along the way. Cancellation between batches still records `lastCompleted`
 * and returns `cancelled: true` so the caller can short-circuit cleanly.
 */
async function scanAndIndexFiles(
  opts: ScanAndIndexOptions,
): Promise<{ filesIndexed: number; chunksCreated: number; cancelled: boolean }> {
  const { resolvedPath, collection, hashes, targetFiles: files, progress, onProgress, hasExistingData } = opts;
  // `currentFileSet` represents files present on disk right now. In the
  // full-project flow this equals `targetFiles`, so the default preserves the
  // pre-refactor behavior. In the sibling-clone flow the caller passes the
  // FULL set of indexable files (not just modified+added) so unchanged files
  // — whose hashes were seeded from the cloned sibling — survive cleanup.
  const currentFileSet = opts.currentFileSet ?? new Set(files);

  // ── Phase 1: Scan and chunk files ──
  interface ChunkedFile {
    relativePath: string;
    absolutePath: string;
    contentHash: string;
    chunks: FileChunk[];
    // When non-null, vectors came from the shared embedding cache and the embed
    // phase can skip the Ollama call for these chunks. The array length matches
    // chunks.length and each vector aligns positionally with its chunk.
    cachedVectors: number[][] | null;
  }

  const cacheEnabled = process.env.SOCRATICODE_EMBEDDING_CACHE === "true";
  const chunkedFiles: ChunkedFile[] = [];
  let skippedCount = 0;
  let cacheHits = 0;

  // Per-file scan candidate: a file that survived stat+read+skip-by-hash and
  // is ready for cache lookup or fresh chunking. `null` means the file was
  // skipped (oversized, unchanged, or read error) and should not be processed
  // further in this batch.
  type ScanCandidate = {
    relativePath: string;
    absolutePath: string;
    content: string;
    contentHash: string;
  };

  for (let i = 0; i < files.length; i += FILE_SCAN_BATCH) {
    const batch = files.slice(i, i + FILE_SCAN_BATCH);

    // Phase 1: parallel stat + read + hash. Skip oversized, unchanged, and
    // read-error files here so they never reach the bulk cache lookup.
    const scanned: Array<ScanCandidate | null> = await Promise.all(
      batch.map(async (relativePath): Promise<ScanCandidate | null> => {
        const absolutePath = path.join(resolvedPath, relativePath);
        try {
          const stat = await fsp.stat(absolutePath);
          if (stat.size > MAX_FILE_BYTES) {
            onProgress?.(`Skipping large file (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${relativePath}`);
            return null;
          }
          const content = await fsp.readFile(absolutePath, "utf-8");
          const contentHash = hashContent(content);

          // Skip unchanged files during re-index
          if (hasExistingData && hashes.get(relativePath) === contentHash) {
            return null;
          }

          return { relativePath, absolutePath, content, contentHash };
        } catch {
          return null;
        }
      }),
    );

    const candidates: ScanCandidate[] = [];
    for (const s of scanned) {
      if (s) candidates.push(s);
      else skippedCount++;
    }

    // Phase 2: one bulk cache lookup for the whole batch. This collapses what
    // used to be FILE_SCAN_BATCH separate Qdrant retrieve round-trips into a
    // single retrieve call per outer batch.
    let cachedByHash: Map<string, CachedEmbedding> = new Map();
    if (cacheEnabled && candidates.length > 0) {
      cachedByHash = await lookupEmbeddings(candidates.map((c) => c.contentHash));
    }

    // Phase 3: assemble ChunkedFile entries. On a cache hit, reuse cached
    // chunks + vectors so chunk IDs and line ranges stay stable across
    // collections. On a miss, fall through to fresh chunking; the embed phase
    // will handle the Ollama call.
    for (const { relativePath, absolutePath, content, contentHash } of candidates) {
      const cached = cachedByHash.get(contentHash);
      if (cached) {
        chunkedFiles.push({
          relativePath,
          absolutePath,
          contentHash,
          chunks: cached.chunks,
          cachedVectors: cached.vectors,
        });
        cacheHits++;
        continue;
      }
      const chunks = chunkFileContent(absolutePath, relativePath, content);
      chunkedFiles.push({ relativePath, absolutePath, contentHash, chunks, cachedVectors: null });
    }

    progress.filesProcessed = Math.min(i + batch.length, files.length);
  }

  if (cacheEnabled && cacheHits > 0) {
    onProgress?.(`Embedding cache: ${cacheHits}/${chunkedFiles.length} files reused from shared cache`);
  }

  if (hasExistingData) {
    onProgress?.(`${chunkedFiles.length} files changed, ${skippedCount} unchanged/skipped`);

    // Defensive guard: if the caller passes (or defaults to) an empty
    // currentFileSet alongside non-empty hashes, the cleanup loop below would
    // delete chunks for every previously-indexed file — catastrophic data
    // loss. The full-project flow's default (`new Set(targetFiles)`) makes
    // this only possible when targetFiles is empty AND hashes were seeded
    // upstream (e.g. a future caller forgetting to pass currentFileSet on
    // the sibling-clone path). Throw rather than silently delete.
    if (currentFileSet.size === 0 && hashes.size > 0) {
      throw new Error(
        `scanAndIndexFiles: refusing to run cleanup with empty currentFileSet ` +
        `but hashes.size=${hashes.size} (would delete every prior chunk).`,
      );
    }

    // Delete old chunks for changed files
    progress.phase = "cleaning stale chunks";
    for (const file of chunkedFiles) {
      if (hashes.has(file.relativePath)) {
        await deleteFileChunks(collection, file.relativePath);
      }
    }

    // Handle deleted files: any previously-indexed path that is NOT in the
    // current working-tree set is stale and must be evicted from both the
    // collection and the in-memory hash map.
    for (const [filePath] of hashes) {
      if (!currentFileSet.has(filePath)) {
        await deleteFileChunks(collection, filePath);
        hashes.delete(filePath);
      }
    }
  }

  // ── Phase 2 & 3: Process files in batches (embed → upsert → checkpoint) ──
  const totalBatches = Math.ceil(chunkedFiles.length / INDEX_BATCH_SIZE) || 1;
  progress.batchesTotal = totalBatches;
  progress.batchesProcessed = 0;

  // Count total chunks across all batches for progress reporting
  let totalChunks = 0;
  for (const file of chunkedFiles) totalChunks += file.chunks.length;
  progress.chunksTotal = totalChunks;
  progress.chunksProcessed = 0;

  let globalChunksProcessed = 0;
  let totalChunksCreated = 0;

  for (let batchIdx = 0; batchIdx < chunkedFiles.length; batchIdx += INDEX_BATCH_SIZE) {
    // ── Cancellation check: stop gracefully between batches ──
    if (isCancellationRequested(resolvedPath)) {
      const chunksIndexed = totalChunksCreated;
      onProgress?.(`Indexing cancelled after ${progress.batchesProcessed ?? 0}/${totalBatches} batches (${chunksIndexed} chunks saved). Progress is preserved — re-run codebase_index to resume.`);
      logger.info("Indexing cancelled by user", { projectPath: resolvedPath, batchesCompleted: progress.batchesProcessed ?? 0, totalBatches, chunksIndexed });
      lastCompleted.set(resolvedPath, {
        type: "full-index",
        completedAt: Date.now(),
        durationMs: Date.now() - progress.startedAt,
        filesProcessed: progress.filesProcessed,
        chunksCreated: chunksIndexed,
        error: "Cancelled by user",
      });
      return { filesIndexed: progress.filesProcessed, chunksCreated: chunksIndexed, cancelled: true };
    }

    const fileBatch = chunkedFiles.slice(batchIdx, batchIdx + INDEX_BATCH_SIZE);
    const batchNum = Math.floor(batchIdx / INDEX_BATCH_SIZE) + 1;

    // Collect chunks for this file batch. fileIdx records which file in
    // fileBatch each chunk belongs to so we can group freshly-embedded
    // vectors back by file when populating the shared cache below.
    const batchChunkData: Array<{
      chunk: FileChunk;
      contentHash: string;
      absolutePath: string;
      cachedVector: number[] | null;
      fileIdx: number;
    }> = [];
    for (let fIdx = 0; fIdx < fileBatch.length; fIdx++) {
      const file = fileBatch[fIdx];
      for (let cIdx = 0; cIdx < file.chunks.length; cIdx++) {
        const chunk = file.chunks[cIdx];
        const cachedVector = file.cachedVectors ? file.cachedVectors[cIdx] : null;
        batchChunkData.push({
          chunk,
          contentHash: file.contentHash,
          absolutePath: file.absolutePath,
          cachedVector,
          fileIdx: fIdx,
        });
      }
    }

    if (batchChunkData.length === 0) {
      progress.batchesProcessed = batchNum;
      continue;
    }

    // BM25 sparse text is needed for every chunk (cached or fresh) to populate
    // Qdrant's sparse index alongside the dense vector.
    const batchBm25Texts = batchChunkData.map((c) =>
      prepareDocumentText(c.chunk.content, c.chunk.relativePath),
    );

    // Embed only the cache-miss chunks; cache-hit chunks short-circuit Ollama.
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < batchChunkData.length; i++) {
      if (batchChunkData[i].cachedVector === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(batchBm25Texts[i]);
      }
    }

    progress.phase = `generating embeddings (batch ${batchNum}/${totalBatches})`;
    if (uncachedTexts.length === 0) {
      onProgress?.(`Batch ${batchNum}/${totalBatches}: ${batchChunkData.length} chunks (${fileBatch.length} files) all served from cache, skipping Ollama...`);
    } else if (uncachedTexts.length < batchChunkData.length) {
      const skipped = batchChunkData.length - uncachedTexts.length;
      onProgress?.(`Batch ${batchNum}/${totalBatches}: generating embeddings for ${uncachedTexts.length} chunks (${skipped} cached) across ${fileBatch.length} files...`);
    } else {
      onProgress?.(`Batch ${batchNum}/${totalBatches}: generating embeddings for ${batchChunkData.length} chunks (${fileBatch.length} files)...`);
    }

    let newEmbeddings: number[][] = [];
    if (uncachedTexts.length > 0) {
      newEmbeddings = await generateEmbeddings(uncachedTexts, (processed) => {
        progress.chunksProcessed = globalChunksProcessed + processed;
      });
    }

    // Stitch cached + freshly-embedded vectors back into the chunk order.
    const batchVectors: number[][] = new Array(batchChunkData.length);
    let uncachedPos = 0;
    for (let i = 0; i < batchChunkData.length; i++) {
      const c = batchChunkData[i];
      if (c.cachedVector !== null) {
        batchVectors[i] = c.cachedVector;
      } else {
        batchVectors[i] = newEmbeddings[uncachedPos];
        uncachedPos++;
      }
    }
    globalChunksProcessed += batchChunkData.length;

    // Upsert this batch to Qdrant
    progress.phase = `storing index (batch ${batchNum}/${totalBatches})`;
    const batchPoints = batchChunkData.map((c, i) => ({
      id: c.chunk.id,
      vector: batchVectors[i],
      bm25Text: batchBm25Texts[i],
      payload: {
        filePath: c.chunk.filePath,
        relativePath: c.chunk.relativePath,
        content: c.chunk.content,
        startLine: c.chunk.startLine,
        endLine: c.chunk.endLine,
        language: c.chunk.language,
        type: c.chunk.type,
        contentHash: c.contentHash,
      },
    }));

    const { pointsSkipped } = await upsertPreEmbeddedChunks(collection, batchPoints).catch((err) => {
      // Enrich the error with batch context for debugging
      const fileList = fileBatch.map((f) => f.relativePath).join(", ");
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Qdrant upsert failed for batch ${batchNum}/${totalBatches} ` +
        `(${batchPoints.length} points, collection=${collection}): ${msg}. ` +
        `Files in batch: ${fileList}`
      );
    });

    if (pointsSkipped > 0 && pointsSkipped === batchPoints.length) {
      // Every point in the batch was rejected. Re-check existence so the error
      // distinguishes "actually deleted" from "transiently rejecting writes"
      // (e.g. mid-recover, concurrent index op, BM25 inference engine init).
      // Per-point error details were already logged via logger.warn in
      // upsertPreEmbeddedChunks's per-point fallback.
      const stillExists = (await getCollectionInfo(collection).catch(() => null)) != null;
      throw new Error(
        `Qdrant upsert: all ${batchPoints.length} points in batch ${batchNum}/${totalBatches} ` +
        `were rejected (collection=${collection}, exists=${stillExists}). ` +
        `${stillExists ? "Collection is alive but rejected every point — likely a transient write window or schema mismatch." : "Collection was deleted externally."} ` +
        `Underlying per-point errors were logged via logger.warn.`
      );
    }

    // Populate the shared embedding cache with vectors we just computed so
    // future indexes of files with identical content hashes can skip Ollama.
    // Only files that came in as cache misses get written back.
    if (cacheEnabled) {
      const vectorsByFileIdx = new Map<number, number[][]>();
      for (let i = 0; i < batchChunkData.length; i++) {
        const fIdx = batchChunkData[i].fileIdx;
        let bucket = vectorsByFileIdx.get(fIdx);
        if (!bucket) {
          bucket = [];
          vectorsByFileIdx.set(fIdx, bucket);
        }
        bucket.push(batchVectors[i]);
      }
      for (let fIdx = 0; fIdx < fileBatch.length; fIdx++) {
        const file = fileBatch[fIdx];
        if (file.cachedVectors !== null) continue;
        const fileVectors = vectorsByFileIdx.get(fIdx);
        if (!fileVectors || fileVectors.length !== file.chunks.length) continue;
        await putEmbedding(file.contentHash, { chunks: file.chunks, vectors: fileVectors });
      }
    }

    // Update hashes for this batch's files
    for (const file of fileBatch) {
      hashes.set(file.relativePath, file.contentHash);
    }
    totalChunksCreated += batchChunkData.length;

    // Checkpoint: persist hashes after each batch so progress survives crashes
    progress.phase = `checkpointing (batch ${batchNum}/${totalBatches})`;
    await saveProjectMetadata(collection, resolvedPath, files.length, hashes.size, hashes, "in-progress");
    progress.batchesProcessed = batchNum;
    onProgress?.(`Batch ${batchNum}/${totalBatches} checkpointed (${totalChunksCreated} chunks so far)`);
  }

  return { filesIndexed: files.length, chunksCreated: totalChunksCreated, cancelled: false };
}

/** Full index of a project directory */
export async function indexProject(
  projectPath: string,
  onProgress?: (message: string) => void,
  extraExtensions?: Set<string>,
): Promise<{ filesIndexed: number; chunksCreated: number; cancelled: boolean }> {
  // Register dynamic AST grammars for AST-aware chunking
  ensureDynamicLanguages();

  const resolvedPath = path.resolve(projectPath);

  // Cross-process lock: prevent two MCP instances from indexing the same project
  const lockAcquired = await acquireProjectLock(resolvedPath, "index");
  if (!lockAcquired) {
    const msg = "Another process is already indexing this project, skipping";
    logger.info(msg, { projectPath: resolvedPath });
    onProgress?.(msg);
    return { filesIndexed: 0, chunksCreated: 0, cancelled: false };
  }

  const progress: IndexingProgress = {
    type: "full-index",
    startedAt: Date.now(),
    filesTotal: 0,
    filesProcessed: 0,
    phase: "setting up",
  };
  indexingInProgress.set(resolvedPath, progress);

  try {
  const projectId = projectIdFromPath(resolvedPath);
  const collection = collectionName(projectId);
  const hashes = await getProjectHashes(projectId, collection, resolvedPath);

  // Snapshot the current git tree once per run. Null when the directory is
  // not a git checkout — in that case we simply don't persist git shas and
  // future fast-path detection silently degrades to a normal scan.
  const currentGitBlobShas = await getGitBlobShas(resolvedPath);

  // Smart re-index: check if collection already has data.
  // getCollectionInfo now throws on transient errors (instead of returning null),
  // so a Qdrant blip will abort the operation rather than trigger a false clean-start.
  let existingInfo: { pointsCount: number; status: string } | null;
  try {
    existingInfo = await getCollectionInfo(collection);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Cannot determine collection state — aborting indexing to protect existing data", {
      collection,
      error: msg,
    });
    throw new Error(`Failed to check collection state for ${collection}: ${msg}. Aborting to avoid accidental data loss.`);
  }
  const hasExistingData = existingInfo !== null && existingInfo.pointsCount > 0;

  // NOTE: ensureCollection(collection) is intentionally deferred to AFTER the
  // sibling-clone gate below. The snapshot+recover clone primitive
  // auto-creates the target collection from the source snapshot's schema —
  // it requires the target NOT to exist. If we ensureCollection upfront we'd
  // pre-create an empty target and recover would fail. On the normal-flow
  // path (no sibling clone taken, or clone failed and we fell through) we
  // call ensureCollection there.

  // ── Fast-path: same-collection skip ──
  // If this collection has prior metadata with gitBlobShas matching the
  // current working tree exactly, the index is already up to date — skip
  // scan + embed and just refresh the graph. Saves the bulk of the work on
  // repeat invocations against an unchanged branch.
  //
  // Conditions for taking the fast path:
  //   1. Project is a git repo (currentGitBlobShas is non-null).
  //   2. Collection already has data + saved gitBlobShas + saved hashes.
  //   3. Saved gitBlobShas matches current working-tree gitBlobShas exactly.
  //
  // Edge cases that intentionally fall through to the normal scan:
  //   - First-time index (hasExistingData = false).
  //   - Project not a git repo (currentGitBlobShas = null).
  //   - Old collection saved before gitBlobShas was tracked (previous = null).
  //   - Any file changed (gitBlobShasEqual returns false).
  //   - Existing data but no in-memory hashes (cannot persist a complete map).
  if (hasExistingData && currentGitBlobShas !== null && hashes.size > 0) {
    const previousGitBlobShas = await loadProjectGitBlobShas(collection).catch(
      () => null,
    );
    if (
      previousGitBlobShas !== null &&
      gitBlobShasEqual(previousGitBlobShas, currentGitBlobShas)
    ) {
      onProgress?.(
        `Fast-path: branch unchanged since last index (${currentGitBlobShas.size} files). Skipping scan + embed.`,
      );
      logger.info("Same-collection fast-skip taken", {
        collection,
        files: currentGitBlobShas.size,
      });

      progress.phase = "building code graph";
      const graphFresh = await isGraphFresh(resolvedPath, currentGitBlobShas).catch(() => false);
      if (graphFresh) {
        onProgress?.(`Code graph fresh — skipping rebuild.`);
        logger.info("Code graph fresh, skipping rebuild", { resolvedPath });
      } else {
        try {
          const graph = await rebuildGraph(resolvedPath, {
            gitBlobShas: currentGitBlobShas,
          });
          onProgress?.(
            `Code graph: ${graph.nodes.length} files, ${graph.edges.length} edges`,
          );
        } catch (graphErr) {
          const graphMsg =
            graphErr instanceof Error ? graphErr.message : String(graphErr);
          logger.warn("Code graph build failed during fast-skip (non-fatal)", {
            projectPath: resolvedPath,
            error: graphMsg,
          });
        }
      }

      progress.phase = "saving metadata";
      await saveProjectMetadata(
        collection,
        resolvedPath,
        hashes.size,
        hashes.size,
        hashes,
        "completed",
        { gitBlobShas: currentGitBlobShas },
      );

      onProgress?.(`Indexing complete (fast-path): ${hashes.size} files, 0 chunks`);
      lastCompleted.set(resolvedPath, {
        type: "full-index",
        completedAt: Date.now(),
        durationMs: Date.now() - progress.startedAt,
        filesProcessed: hashes.size,
        chunksCreated: 0,
      });
      return { filesIndexed: hashes.size, chunksCreated: 0, cancelled: false };
    }
  }

  // ── Fast-path: sibling-clone ──
  // Bootstrapping a new (or empty) collection? Look for a sibling collection
  // whose gitBlobShas overlap with the current working tree. If found:
  //   1. Clone all of sibling's points into the target (~30s for 125k chunks).
  //   2. Diff the trees (unchanged / modified / added / deleted).
  //   3. Delete chunks for modified + deleted files (modified files re-chunk
  //      below; explicit delete prevents stale chunks at line offsets that
  //      no longer exist after edits).
  //   4. Run scan + embed only on (modified + added) — most files are reused.
  //   5. Save metadata with current gitBlobShas so future runs hit fast paths.
  //
  // On any error during clone, we fall through to the normal full-index path
  // below. The collection we partially populated will be overwritten by the
  // upsert calls in scanAndIndexFiles.
  const collectionEmpty = !hasExistingData;
  if (
    collectionEmpty &&
    currentGitBlobShas !== null &&
    currentGitBlobShas.size > 0
  ) {
    const sibling = await findSiblingMetadata(
      resolvedPath,
      currentGitBlobShas,
      collection,
    ).catch((err) => {
      logger.error("findSiblingMetadata threw", {
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return null;
    });

    if (sibling !== null) {
      const diff = diffGitTrees(sibling.gitBlobShas, currentGitBlobShas);
      onProgress?.(
        `Sibling-clone candidate: ${sibling.collectionName} (${sibling.matchCount}/${currentGitBlobShas.size} files match). ` +
          `Diff: ${diff.unchanged.length} unchanged, ${diff.modified.length} modified, ` +
          `${diff.added.length} added, ${diff.deleted.length} deleted.`,
      );

      try {
        progress.phase = "cloning sibling collection";
        const cloned = await cloneCollectionPoints(
          sibling.collectionName,
          collection,
        );
        onProgress?.(`Cloned ${cloned} points from ${sibling.collectionName}.`);

        // Drop chunks for files that changed (modified) or no longer exist
        // (deleted). Batched into a single filter delete with a path-IN
        // clause — N round-trips → 1 — so post-clone cleanup doesn't dominate
        // wall time when the diff is in the thousands.
        const stalePaths = [...diff.deleted, ...diff.modified];
        if (stalePaths.length > 0) {
          progress.phase = "cleaning stale chunks";
          await deleteFileChunksBatch(collection, stalePaths);
          onProgress?.(`Pruned chunks for ${stalePaths.length} stale files.`);
        }

        // Seed `hashes` with the unchanged paths' content hashes so the scan
        // helper's skip-by-hash short-circuit kicks in immediately for any
        // unchanged file that does end up in the scan set.
        for (const unchangedPath of diff.unchanged) {
          const sha = sibling.fileHashes.get(unchangedPath);
          if (sha !== undefined) hashes.set(unchangedPath, sha);
        }

        // Build the path subset to scan: modified + added only.
        const subsetSet = new Set<string>([...diff.modified, ...diff.added]);
        const allFiles = await getIndexableFiles(resolvedPath, extraExtensions);
        const targetFiles = allFiles.filter((p) => subsetSet.has(p));
        progress.filesTotal = allFiles.length;
        onProgress?.(
          `Indexing ${targetFiles.length} changed file${targetFiles.length === 1 ? "" : "s"} (${diff.unchanged.length} reused via clone).`,
        );

        const cloneResult = await scanAndIndexFiles({
          resolvedPath,
          collection,
          hashes,
          targetFiles,
          // Pass the FULL working-tree set so the helper's stale-cleanup
          // loop only deletes chunks for files genuinely missing from disk.
          // Without this the loop would walk `hashes` (seeded above with
          // diff.unchanged) and delete every unchanged path because none of
          // them are in the targetFiles subset.
          currentFileSet: new Set(allFiles),
          progress,
          onProgress,
          // We just cloned points into the collection; treat as existing data
          // so the helper's skip-by-hash + stale-chunk paths behave correctly.
          hasExistingData: true,
        });

        if (cloneResult.cancelled) {
          return cloneResult;
        }

        // ── Codegraph fast-path: clone symgraph + codegraph metadata ──
        // When the working tree exactly matches the sibling's, the sibling's
        // codegraph is also bit-identical and can be reused via collection
        // clone instead of paying the ~150s rebuildGraph cost. CodeGraphNode
        // file paths are absolute, but the collection-list-based sibling
        // discovery filters by `coreProjectId` (path hash) so siblings are
        // always same-worktree — paths in the cloned graph already match.
        const isZeroDiff =
          diff.modified.length === 0 &&
          diff.added.length === 0 &&
          diff.deleted.length === 0;
        let codegraphCloned = false;
        if (isZeroDiff && sibling.hasCompleteGraphState) {
          const siblingProjectId = sibling.collectionName.replace(
            /^codebase_/,
            "",
          );
          try {
            progress.phase = "cloning code graph";
            await replaceCollectionFromSibling(
              symgraphMetaCollectionName(siblingProjectId),
              symgraphMetaCollectionName(projectId),
            );
            await replaceCollectionFromSibling(
              symgraphFileCollectionName(siblingProjectId),
              symgraphFileCollectionName(projectId),
            );
            await replaceCollectionFromSibling(
              symgraphIndexCollectionName(siblingProjectId),
              symgraphIndexCollectionName(projectId),
            );
            const copied = await cloneGraphMetadataPoint(
              graphCollectionName(siblingProjectId),
              graphCollectionName(projectId),
              { projectPath: resolvedPath, gitBlobShas: currentGitBlobShas },
            );
            if (copied) {
              invalidateGraphCache(resolvedPath);
              dropSymbolGraphCache(projectId);
              codegraphCloned = true;
              onProgress?.(`Cloned code graph from sibling.`);
            }
          } catch (graphCloneErr) {
            logger.warn(
              "Sibling codegraph clone failed; falling through to rebuildGraph",
              {
                projectPath: resolvedPath,
                error:
                  graphCloneErr instanceof Error
                    ? graphCloneErr.message
                    : String(graphCloneErr),
              },
            );
            // Fall through: rebuildGraph below will still catch this case.
          }
        }

        progress.phase = "building code graph";
        // Trust a successful clone over a follow-up freshness read: the clone
        // wrote `currentGitBlobShas` directly, so by definition the graph is
        // fresh. Skipping the read-back avoids a race where the upsert is
        // queued but not yet visible to the immediate retrieve.
        const graphFresh =
          codegraphCloned ||
          (await isGraphFresh(resolvedPath, currentGitBlobShas).catch(() => false));

        // Small-diff sibling-clone fast path (Phase 4-A).
        //   Mirrors the watcher path's incremental strategy: when the diff is
        //   small (≤ INCREMENTAL_SYMBOL_THRESHOLD files) we clone the sibling's
        //   symgraph collections to seed a baseline, rebuild only the
        //   file-import graph (parse pass #1 — mostly cache hits thanks to
        //   Phase 4-E's blob-sha symbol cache), then patch only the changed
        //   files' symbol payloads. Avoids the ~150s end-to-end symbol-graph
        //   rebuild for small branch diffs.
        //
        //   `rebuildGraph(skipSymbolGraph: true)` overwrites the codegraph
        //   metadata point via saveGraphData, so we deliberately do NOT clone
        //   that point here — only the three symgraph collections need a
        //   baseline for the incremental updater to mutate.
        const smallDiffChangedCount =
          diff.modified.length + diff.added.length + diff.deleted.length;
        const smallDiffEligible =
          !graphFresh &&
          sibling.hasCompleteGraphState &&
          smallDiffChangedCount > 0 &&
          smallDiffChangedCount <= INCREMENTAL_SYMBOL_THRESHOLD;
        let smallDiffApplied = false;
        if (smallDiffEligible) {
          const siblingProjectId = sibling.collectionName.replace(
            /^codebase_/,
            "",
          );
          try {
            progress.phase = "cloning symbol graph baseline";
            await replaceCollectionFromSibling(
              symgraphMetaCollectionName(siblingProjectId),
              symgraphMetaCollectionName(projectId),
            );
            await replaceCollectionFromSibling(
              symgraphFileCollectionName(siblingProjectId),
              symgraphFileCollectionName(projectId),
            );
            await replaceCollectionFromSibling(
              symgraphIndexCollectionName(siblingProjectId),
              symgraphIndexCollectionName(projectId),
            );
            // Drop the in-process symbol-graph cache so the incremental
            // updater reads the freshly-cloned shards from Qdrant rather
            // than any stale cached state for this projectId.
            dropSymbolGraphCache(projectId);

            progress.phase = "building code graph";
            const graph = await rebuildGraph(resolvedPath, {
              skipSymbolGraph: true,
              gitBlobShas: currentGitBlobShas,
            });
            onProgress?.(
              `Code graph: ${graph.nodes.length} files, ${graph.edges.length} edges (file-import only)`,
            );

            const incResult = await updateChangedFilesSymbolGraph(
              projectId,
              resolvedPath,
              graph,
              [...diff.modified, ...diff.added],
              diff.deleted,
            );
            if (incResult.fullRebuildRequired) {
              // Cloned meta vanished or was malformed — fall back to a full
              // symbol-graph rebuild. Rare, but safe.
              onProgress?.(
                "Symbol graph meta missing after clone — falling back to full rebuild",
              );
              await rebuildGraph(resolvedPath, {
                skipSymbolGraph: false,
                gitBlobShas: currentGitBlobShas,
              });
            } else {
              onProgress?.(
                `Symbol graph patched: +${incResult.symbolsDelta} symbols, ` +
                  `+${incResult.edgesDelta} edges (${incResult.filesChanged} changed, ${incResult.filesRemoved} removed)`,
              );
            }
            smallDiffApplied = true;
          } catch (smallDiffErr) {
            const smallDiffMsg =
              smallDiffErr instanceof Error
                ? smallDiffErr.message
                : String(smallDiffErr);
            logger.warn(
              "Sibling-clone small-diff incremental path failed; falling through to full rebuild",
              { projectPath: resolvedPath, error: smallDiffMsg },
            );
            // Fall through to the full-rebuild branch below.
          }
        }

        if (graphFresh) {
          onProgress?.(`Code graph fresh — skipping rebuild.`);
          logger.info("Code graph fresh, skipping rebuild", {
            resolvedPath,
            cloned: codegraphCloned,
          });
        } else if (!smallDiffApplied) {
          try {
            const graph = await rebuildGraph(resolvedPath, {
              gitBlobShas: currentGitBlobShas,
            });
            onProgress?.(
              `Code graph: ${graph.nodes.length} files, ${graph.edges.length} edges`,
            );
          } catch (graphErr) {
            const graphMsg =
              graphErr instanceof Error ? graphErr.message : String(graphErr);
            logger.warn(
              "Code graph build failed during sibling-clone (non-fatal)",
              { projectPath: resolvedPath, error: graphMsg },
            );
          }
        }

        progress.phase = "saving metadata";
        await saveProjectMetadata(
          collection,
          resolvedPath,
          allFiles.length,
          hashes.size,
          hashes,
          "completed",
          { gitBlobShas: currentGitBlobShas },
        );

        const totalFilesIndexed =
          cloneResult.filesIndexed + diff.unchanged.length;
        onProgress?.(
          `Indexing complete (sibling-clone): ${totalFilesIndexed} files, ${cloneResult.chunksCreated} chunks`,
        );
        lastCompleted.set(resolvedPath, {
          type: "full-index",
          completedAt: Date.now(),
          durationMs: Date.now() - progress.startedAt,
          filesProcessed: totalFilesIndexed,
          chunksCreated: cloneResult.chunksCreated,
        });
        return {
          filesIndexed: totalFilesIndexed,
          chunksCreated: cloneResult.chunksCreated,
          cancelled: false,
        };
      } catch (cloneErr) {
        logger.warn(
          "Sibling-clone fast path failed; falling through to full index",
          {
            sibling: sibling.collectionName,
            error: cloneErr instanceof Error ? cloneErr.message : String(cloneErr),
          },
        );
        // Recover may have left no target collection at all OR a partial
        // one (e.g. snapshot succeeded, recover started, then errored
        // mid-stream). Drop whatever's there before falling through to the
        // normal flow so ensureCollection below can recreate a clean,
        // empty collection with the expected schema.
        await deleteCollection(collection).catch(() => {});
        // Fall through to normal flow below.
      }
    }
  }

  // Normal-flow path: no sibling-clone taken (or clone failed and we fell
  // through). Ensure the target collection exists with the right schema
  // before scan + embed. Idempotent — no-op if the collection already exists.
  await ensureCollection(collection);

  if (hasExistingData) {
    if (hashes.size > 0) {
      onProgress?.(`Existing index found (${existingInfo?.pointsCount} chunks, ${hashes.size} file hashes), resuming...`);
    } else {
      // Collection has data but no hashes — likely a crash before metadata was saved,
      // or hashes were lost. Re-embed everything but keep existing chunks to avoid
      // destroying a partially completed index.
      onProgress?.(`Existing index found (${existingInfo?.pointsCount} chunks, no file hashes). Re-indexing all files (existing chunks preserved)...`);
    }
  } else {
    // Collection is empty or was just created — fresh start, clear any stale in-memory hashes
    if (existingInfo === null) {
      onProgress?.(`Setting up collection ${collection} (new)...`);
      logger.info("Collection did not exist, created fresh", { collection });
    } else {
      onProgress?.(`Setting up collection ${collection} (empty, reusing)...`);
      logger.info("Collection exists but is empty, reusing", { collection, pointsCount: existingInfo.pointsCount });
    }
    hashes.clear();
  }

  // ── Phase 1: Scan + embed AND build code graph (concurrently — Phase 4-G) ──
  // The two pipelines touch disjoint state: scanAndIndexFiles upserts to
  // codebase_<id>, while rebuildGraph reads source files from disk and
  // writes codegraph_<id> + symgraph_*. Running them in parallel saves
  // wall-time on cold/non-sibling indexes (where both are non-trivial).
  //
  // Cancellation note: rebuildGraph has no abort-signal plumbing today, so a
  // mid-scan cancel will still wait for the in-flight graph build to settle
  // before returning. We accept this — the graph build is bounded and the
  // user gets a valid graph even on a cancelled scan.
  progress.phase = "scanning files";
  const files = await getIndexableFiles(resolvedPath, extraExtensions);
  progress.filesTotal = files.length;
  onProgress?.(`Found ${files.length} indexable files`);

  // Compute graph freshness up-front (cheap; one Qdrant retrieve) so the
  // graph promise is a no-op when the working tree hasn't moved.
  const cgFresh =
    currentGitBlobShas !== null
      ? await isGraphFresh(resolvedPath, currentGitBlobShas).catch(() => false)
      : false;

  // Kick off the graph build. The IIFE shape ensures the promise is
  // scheduled NOW (before we await scan), so the two pipelines actually
  // run concurrently rather than serializing on the await order.
  const graphPromise: Promise<void> = cgFresh
    ? (async () => {
        onProgress?.(`Code graph fresh — skipping rebuild.`);
        logger.info("Code graph fresh, skipping rebuild", { resolvedPath });
      })()
    : (async () => {
        onProgress?.("Building code dependency graph...");
        try {
          const graph = await rebuildGraph(
            resolvedPath,
            currentGitBlobShas !== null
              ? { gitBlobShas: currentGitBlobShas }
              : undefined,
          );
          onProgress?.(
            `Code graph built: ${graph.nodes.length} files, ${graph.edges.length} edges`,
          );
        } catch (graphErr) {
          const graphMsg =
            graphErr instanceof Error ? graphErr.message : String(graphErr);
          logger.warn("Code graph build failed (non-fatal)", {
            projectPath: resolvedPath,
            error: graphMsg,
          });
          onProgress?.(`Code graph build failed (non-fatal): ${graphMsg}`);
        }
      })();

  const scanResult = await scanAndIndexFiles({
    resolvedPath,
    collection,
    hashes,
    targetFiles: files,
    progress,
    onProgress,
    hasExistingData,
  });

  if (scanResult.cancelled) {
    // Wait for the dangling graph promise so we don't leak it past the
    // function return. graphPromise never rejects (errors are caught
    // inside the IIFE), so this await is safe.
    await graphPromise;
    return scanResult;
  }

  const filesIndexed = scanResult.filesIndexed;
  const chunksCreated = scanResult.chunksCreated;

  // Final metadata save (depends on scanResult; can run in parallel with
  // the tail of the graph build).
  progress.phase = "saving metadata";
  await saveProjectMetadata(
    collection,
    resolvedPath,
    filesIndexed,
    hashes.size,
    hashes,
    "completed",
    currentGitBlobShas != null ? { gitBlobShas: currentGitBlobShas } : undefined,
  );

  // Surface the graph phase to status consumers if the build is still
  // in-flight, then await it.
  progress.phase = "building code graph";
  await graphPromise;

  // Auto-index context artifacts if .socraticodecontextartifacts.json exists
  try {
    const artifactConfig = await loadConfig(resolvedPath);
    if (artifactConfig?.artifacts?.length) {
      progress.phase = "indexing context artifacts";
      onProgress?.(`Indexing ${artifactConfig.artifacts.length} context artifact${artifactConfig.artifacts.length === 1 ? "" : "s"}...`);
      const result = await ensureArtifactsIndexed(resolvedPath);
      if (result.reindexed.length > 0) {
        onProgress?.(`Context artifacts: ${result.reindexed.length} indexed/re-indexed, ${result.upToDate.length} up-to-date`);
      } else {
        onProgress?.(`Context artifacts: ${result.upToDate.length} artifact${result.upToDate.length === 1 ? "" : "s"} up-to-date`);
      }
    }
  } catch (artifactErr) {
    const artifactMsg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    logger.warn("Context artifact indexing failed (non-fatal)", { projectPath: resolvedPath, error: artifactMsg });
    onProgress?.(`Context artifact indexing failed (non-fatal): ${artifactMsg}`);
  }

  onProgress?.(`Indexing complete: ${filesIndexed} files, ${chunksCreated} chunks`);
  lastCompleted.set(resolvedPath, {
    type: "full-index",
    completedAt: Date.now(),
    durationMs: Date.now() - progress.startedAt,
    filesProcessed: filesIndexed,
    chunksCreated,
  });
  return { filesIndexed, chunksCreated, cancelled: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.error = message;
    lastCompleted.set(resolvedPath, {
      type: "full-index",
      completedAt: Date.now(),
      durationMs: Date.now() - progress.startedAt,
      filesProcessed: progress.filesProcessed,
      chunksCreated: 0,
      error: message,
    });
    throw err;
  } finally {
    indexingInProgress.delete(resolvedPath);
    cancellationRequested.delete(resolvedPath);
    await releaseProjectLock(resolvedPath, "index");
  }
}

/** Incremental update: only re-index changed/new files, remove deleted ones */
export async function updateProjectIndex(
  projectPath: string,
  onProgress?: (message: string) => void,
  extraExtensions?: Set<string>,
): Promise<{ added: number; updated: number; removed: number; chunksCreated: number; cancelled: boolean }> {
  ensureDynamicLanguages();

  const resolvedPath = path.resolve(projectPath);

  // Cross-process lock: prevent two MCP instances from updating the same project
  const lockAcquired = await acquireProjectLock(resolvedPath, "index");
  if (!lockAcquired) {
    const msg = "Another process is already indexing this project, skipping";
    logger.info(msg, { projectPath: resolvedPath });
    onProgress?.(msg);
    return { added: 0, updated: 0, removed: 0, chunksCreated: 0, cancelled: false };
  }

  const progress: IndexingProgress = {
    type: "incremental-update",
    startedAt: Date.now(),
    filesTotal: 0,
    filesProcessed: 0,
    phase: "checking for changes",
  };
  indexingInProgress.set(resolvedPath, progress);

  try {
  const projectId = projectIdFromPath(resolvedPath);
  const collection = collectionName(projectId);
  const hashes = await getProjectHashes(projectId, collection, resolvedPath);

  // Snapshot the current git tree once per run. Null for non-git checkouts
  // (or unreadable indexes); in that case future fast-path detection
  // silently falls back to a content-hash scan.
  const currentGitBlobShas = await getGitBlobShas(resolvedPath);

  // Ensure collection exists — getCollectionInfo now throws on transient errors,
  // so a network blip will abort rather than cascade into a destructive fallback.
  let info: { pointsCount: number; status: string } | null;
  try {
    info = await getCollectionInfo(collection);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Cannot determine collection state during update — aborting to protect existing data", {
      collection,
      error: msg,
    });
    throw new Error(`Failed to check collection state for ${collection}: ${msg}. Aborting to avoid accidental data loss.`);
  }

  if (!info || info.pointsCount === 0) {
    // Collection truly doesn't exist or is empty — safe to do a full index
    onProgress?.("No existing index found, performing full index...");
    const result = await indexProject(projectPath, onProgress, extraExtensions);
    return { added: result.filesIndexed, updated: 0, removed: 0, chunksCreated: result.chunksCreated, cancelled: result.cancelled };
  }

  if (hashes.size === 0) {
    // Collection has data but no hashes — do NOT fall through to a clean full index
    // that might delete the collection. Instead, call indexProject which will detect
    // existing data via getCollectionInfo and use re-index mode (preserving the collection).
    onProgress?.(`No metadata found for existing index (${info.pointsCount} chunks). Re-indexing all files (existing data preserved)...`);
    logger.info("updateProjectIndex: falling back to re-index (no hashes, but collection has data)", {
      collection,
      pointsCount: info.pointsCount,
    });
    const result = await indexProject(projectPath, onProgress, extraExtensions);
    return { added: result.filesIndexed, updated: 0, removed: 0, chunksCreated: result.chunksCreated, cancelled: result.cancelled };
  }

  // ── Phase 1: Scan files and identify changes ──
  progress.phase = "scanning for changes";
  const currentFiles = await getIndexableFiles(resolvedPath, extraExtensions);
  progress.filesTotal = currentFiles.length;
  onProgress?.(`Found ${currentFiles.length} indexable files, scanning for changes...`);
  const currentFileSet = new Set(currentFiles);

  interface ChangedFile {
    relativePath: string;
    absolutePath: string;
    contentHash: string;
    chunks: FileChunk[];
    isNew: boolean;
  }

  const changedFiles: ChangedFile[] = [];

  for (let i = 0; i < currentFiles.length; i += FILE_SCAN_BATCH) {
    const batch = currentFiles.slice(i, i + FILE_SCAN_BATCH);
    const results = await Promise.all(
      batch.map(async (relativePath): Promise<ChangedFile | null> => {
        const absolutePath = path.join(resolvedPath, relativePath);
        try {
          const stat = await fsp.stat(absolutePath);
          if (stat.size > MAX_FILE_BYTES) {
            onProgress?.(`Skipping large file (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${relativePath}`);
            return null;
          }
          const content = await fsp.readFile(absolutePath, "utf-8");
          const contentHash = hashContent(content);
          const existingHash = hashes.get(relativePath);

          if (existingHash === contentHash) return null;

          const chunks = chunkFileContent(absolutePath, relativePath, content);
          return { relativePath, absolutePath, contentHash, chunks, isNew: !existingHash };
        } catch {
          return null;
        }
      }),
    );

    changedFiles.push(...results.filter((r): r is ChangedFile => r !== null));
    progress.filesProcessed = Math.min(i + batch.length, currentFiles.length);
  }

  const unchangedCount = currentFiles.length - changedFiles.length;
  onProgress?.(`${changedFiles.length} files changed, ${unchangedCount} unchanged/skipped`);

  let added = 0;
  let updated = 0;
  let removed = 0;
  let chunksCreated = 0;

  if (changedFiles.length > 0) {
    // Delete old chunks for updated (not new) files
    progress.phase = "cleaning stale chunks";
    for (const file of changedFiles) {
      if (!file.isNew) {
        await deleteFileChunks(collection, file.relativePath);
      }
    }

    // ── Phase 2 & 3: Process changed files in batches (embed → upsert → checkpoint) ──
    const totalBatches = Math.ceil(changedFiles.length / INDEX_BATCH_SIZE) || 1;
    progress.batchesTotal = totalBatches;
    progress.batchesProcessed = 0;

    // Count total chunks across all batches
    let totalChunksCount = 0;
    for (const file of changedFiles) totalChunksCount += file.chunks.length;
    progress.chunksTotal = totalChunksCount;
    progress.chunksProcessed = 0;

    let globalChunksProcessed = 0;

    for (let batchIdx = 0; batchIdx < changedFiles.length; batchIdx += INDEX_BATCH_SIZE) {
      // ── Cancellation check: stop gracefully between batches ──
      if (isCancellationRequested(resolvedPath)) {
        onProgress?.(`Update cancelled after ${progress.batchesProcessed ?? 0}/${totalBatches} batches (${chunksCreated} chunks saved). Progress is preserved — re-run codebase_update to resume.`);
        logger.info("Incremental update cancelled by user", { projectPath: resolvedPath, batchesCompleted: progress.batchesProcessed ?? 0, totalBatches, chunksCreated });
        lastCompleted.set(resolvedPath, {
          type: "incremental-update",
          completedAt: Date.now(),
          durationMs: Date.now() - progress.startedAt,
          filesProcessed: progress.filesProcessed,
          chunksCreated,
          error: "Cancelled by user",
        });
        return { added, updated, removed, chunksCreated, cancelled: true };
      }

      const fileBatch = changedFiles.slice(batchIdx, batchIdx + INDEX_BATCH_SIZE);
      const batchNum = Math.floor(batchIdx / INDEX_BATCH_SIZE) + 1;

      // Collect chunks for this file batch
      const batchChunkData: Array<{ chunk: FileChunk; contentHash: string }> = [];
      for (const file of fileBatch) {
        for (const chunk of file.chunks) {
          batchChunkData.push({ chunk, contentHash: file.contentHash });
        }
      }

      if (batchChunkData.length === 0) {
        progress.batchesProcessed = batchNum;
        continue;
      }

      // Generate embeddings for this batch
      progress.phase = `generating embeddings (batch ${batchNum}/${totalBatches})`;
      onProgress?.(`Batch ${batchNum}/${totalBatches}: generating embeddings for ${batchChunkData.length} chunks (${fileBatch.length} files changed)...`);

      const batchTexts = batchChunkData.map((c) => prepareDocumentText(c.chunk.content, c.chunk.relativePath));
      const batchEmbeddings = await generateEmbeddings(batchTexts, (processed) => {
        progress.chunksProcessed = globalChunksProcessed + processed;
      });
      globalChunksProcessed += batchChunkData.length;

      // Upsert this batch to Qdrant
      progress.phase = `storing index (batch ${batchNum}/${totalBatches})`;
      const batchPoints = batchChunkData.map((c, i) => ({
        id: c.chunk.id,
        vector: batchEmbeddings[i],
        bm25Text: batchTexts[i],
        payload: {
          filePath: c.chunk.filePath,
          relativePath: c.chunk.relativePath,
          content: c.chunk.content,
          startLine: c.chunk.startLine,
          endLine: c.chunk.endLine,
          language: c.chunk.language,
          type: c.chunk.type,
          contentHash: c.contentHash,
        },
      }));

      const { pointsSkipped } = await upsertPreEmbeddedChunks(collection, batchPoints);

      if (pointsSkipped > 0 && pointsSkipped === batchPoints.length) {
        // Re-check existence so the error distinguishes "actually deleted"
        // from "transiently rejecting writes" (e.g. mid-recover, concurrent
        // index op, BM25 inference engine init). Per-point error details were
        // already logged via logger.warn in upsertPreEmbeddedChunks's
        // per-point fallback.
        const stillExists = (await getCollectionInfo(collection).catch(() => null)) != null;
        throw new Error(
          `Qdrant upsert: all ${batchPoints.length} points in batch ${batchNum}/${totalBatches} ` +
          `were rejected (collection=${collection}, exists=${stillExists}). ` +
          `${stillExists ? "Collection is alive but rejected every point — likely a transient write window or schema mismatch." : "Collection was deleted externally."} ` +
          `Underlying per-point errors were logged via logger.warn.`
        );
      }

      // Update hashes and counts for this batch's files
      for (const file of fileBatch) {
        hashes.set(file.relativePath, file.contentHash);
        if (file.isNew) added++;
        else updated++;
      }
      chunksCreated += batchChunkData.length;

      // Checkpoint: persist hashes after each batch
      progress.phase = `checkpointing (batch ${batchNum}/${totalBatches})`;
      await saveProjectMetadata(collection, resolvedPath, currentFiles.length, hashes.size, hashes, "in-progress");
      progress.batchesProcessed = batchNum;
      onProgress?.(`Batch ${batchNum}/${totalBatches} checkpointed (${chunksCreated} chunks so far)`);
    }
  }

  // Check for deleted files
  progress.phase = "removing deleted files";
  const removedRelPaths: string[] = [];
  for (const [filePath] of hashes) {
    if (!currentFileSet.has(filePath)) {
      await deleteFileChunks(collection, filePath);
      hashes.delete(filePath);
      removed++;
      removedRelPaths.push(filePath);
    }
  }

  // Persist updated hashes
  await saveProjectMetadata(
    collection,
    resolvedPath,
    currentFiles.length,
    hashes.size,
    hashes,
    "completed",
    currentGitBlobShas != null ? { gitBlobShas: currentGitBlobShas } : undefined,
  );

  // Auto-rebuild code graph if any files changed (Phase F).
  //
  // Strategy:
  //   - If a symbol-graph already exists AND the change set is small
  //     (≤ INCREMENTAL_SYMBOL_THRESHOLD files), do a fast file-import-graph
  //     rebuild then patch the symbol graph per-file via
  //     `updateChangedFilesSymbolGraph`.
  //   - Otherwise fall back to a full `rebuildGraph()` that also rebuilds
  //     the symbol graph end-to-end.
  if (added > 0 || updated > 0 || removed > 0) {
    progress.phase = "building code graph";
    const projectId = projectIdFromPath(resolvedPath);
    const totalChanged = changedFiles.length + removedRelPaths.length;
    const meta = await loadSymbolGraphMeta(projectId).catch(() => null);
    const useIncremental = meta !== null && totalChanged <= INCREMENTAL_SYMBOL_THRESHOLD;

    try {
      onProgress?.(
        useIncremental
          ? `Building file graph + incrementally updating ${totalChanged} symbol payload(s)...`
          : "Building code dependency graph (full rebuild)...",
      );
      const blobsForRebuild = currentGitBlobShas ?? undefined;
      const graph = await rebuildGraph(resolvedPath, {
        skipSymbolGraph: useIncremental,
        gitBlobShas: blobsForRebuild,
      });
      onProgress?.(`Code graph built: ${graph.nodes.length} files, ${graph.edges.length} edges`);

      if (useIncremental) {
        try {
          const result = await updateChangedFilesSymbolGraph(
            projectId,
            resolvedPath,
            graph,
            changedFiles.map((f) => f.relativePath),
            removedRelPaths,
          );
          if (result.fullRebuildRequired) {
            // Meta vanished between checks — fall back to a full symbol rebuild.
            onProgress?.("Symbol graph meta missing — falling back to full rebuild");
            await rebuildGraph(resolvedPath, {
              skipSymbolGraph: false,
              gitBlobShas: blobsForRebuild,
            });
          } else {
            onProgress?.(
              `Symbol graph patched: +${result.symbolsDelta} symbols, ` +
                `+${result.edgesDelta} edges (${result.filesChanged} changed, ${result.filesRemoved} removed)`,
            );
          }
        } catch (incErr) {
          // Last-resort fallback: full rebuild. Never let watcher fail.
          const incMsg = incErr instanceof Error ? incErr.message : String(incErr);
          logger.warn("Incremental symbol-graph update failed; falling back to full rebuild", {
            projectPath: resolvedPath,
            error: incMsg,
          });
          await rebuildGraph(resolvedPath, {
            skipSymbolGraph: false,
            gitBlobShas: blobsForRebuild,
          });
        }
      }
    } catch (graphErr) {
      const graphMsg = graphErr instanceof Error ? graphErr.message : String(graphErr);
      logger.warn("Code graph build failed during incremental update (non-fatal)", { projectPath: resolvedPath, error: graphMsg });
      onProgress?.(`Code graph build failed (non-fatal): ${graphMsg}`);
    }
  }

  // Auto-index context artifacts if changed (non-fatal)
  try {
    const artifactConfig = await loadConfig(resolvedPath);
    if (artifactConfig?.artifacts?.length) {
      progress.phase = "indexing context artifacts";
      const result = await ensureArtifactsIndexed(resolvedPath);
      if (result.reindexed.length > 0) {
        onProgress?.(`Context artifacts: ${result.reindexed.length} indexed/re-indexed, ${result.upToDate.length} up-to-date`);
      }
    }
  } catch (artifactErr) {
    const artifactMsg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
    logger.warn("Context artifact indexing failed during incremental update (non-fatal)", { projectPath: resolvedPath, error: artifactMsg });
  }

  onProgress?.(`Update complete: ${added} added, ${updated} updated, ${removed} removed`);
  lastCompleted.set(resolvedPath, {
    type: "incremental-update",
    completedAt: Date.now(),
    durationMs: Date.now() - progress.startedAt,
    filesProcessed: added + updated,
    chunksCreated,
  });
  return { added, updated, removed, chunksCreated, cancelled: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.error = message;
    lastCompleted.set(resolvedPath, {
      type: "incremental-update",
      completedAt: Date.now(),
      durationMs: Date.now() - progress.startedAt,
      filesProcessed: progress.filesProcessed,
      chunksCreated: 0,
      error: message,
    });
    throw err;
  } finally {
    indexingInProgress.delete(resolvedPath);
    cancellationRequested.delete(resolvedPath);
    await releaseProjectLock(resolvedPath, "index");
  }
}

/** Remove an entire project index */
export async function removeProjectIndex(projectPath: string): Promise<void> {
  const resolvedPath = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedPath);
  const collection = collectionName(projectId);
  await deleteCollection(collection);
  await deleteProjectMetadata(collection);
  // Also remove the code graph
  await removeGraph(resolvedPath);
  // Also remove context artifacts (if any)
  await removeAllArtifacts(resolvedPath);
  projectHashes.delete(projectId);
  projectHashesLoaded.delete(projectId);
}
