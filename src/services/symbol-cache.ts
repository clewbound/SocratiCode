// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { createHash } from "node:crypto";
import type { ImportInfo } from "./graph-imports.js";
import type { ExtractedSymbols } from "./graph-symbols.js";
import { logger } from "./logger.js";
import { ensureSymbolCacheCollection, getClient } from "./qdrant.js";

export const SYMBOL_CACHE_COLLECTION = "socraticode_symbol_cache";

/**
 * Schema version for cached symbol entries. Bump this whenever the shape or
 * semantics of `symbols`, `rawCalls`, or `imports` change so old cache entries
 * are invalidated automatically:
 *
 *  - Adding/removing/renaming fields in `SymbolNode` / `ImportInfo`.
 *  - Changing `extractImports` or `extractSymbolsAndCalls` to emit different
 *    structure for the same input (e.g. tighter ID format).
 *  - Adjusting the `<module>` synthetic symbol generation.
 *
 * The version is mixed into the point id so a bumped version simply produces
 * a fresh cache miss on every file.
 */
export const SYMBOL_CACHE_SCHEMA_VERSION = 1;

/** What we store/retrieve per `(language, blobSha)` slot. */
export interface CachedSymbolEntry {
  lang: string;
  blobSha: string;
  symbols: ExtractedSymbols["symbols"];
  rawCalls: ExtractedSymbols["rawCalls"];
  imports: ImportInfo[];
}

interface StoredPayload extends CachedSymbolEntry {
  schemaVersion: number;
  storedAt: string;
}

/** Stable lookup key combining schema version, language, and blob SHA.
 *  `lang` is part of the key (not just `blobSha`) to defend against
 *  content-equivalent files that ast-grep would parse with different
 *  grammars (e.g. a `.h` shared between C and C++ projects). */
export function symbolCacheKey(lang: string, blobSha: string): string {
  return `${SYMBOL_CACHE_SCHEMA_VERSION}:${lang}:${blobSha}`;
}

/** Derives a UUID-shaped point ID from a cache key. Mirrors the convention
 *  used by `embedding-cache.ts` and `metadataPointId` in qdrant.ts so the
 *  cache collection plays well with existing tooling. */
function pointId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Bulk lookup: fetch cached symbol-extraction output for many `(lang, blobSha)`
 *  pairs in a single Qdrant retrieve. Returns a map keyed by `(lang, blobSha)`
 *  via {@link symbolCacheKey}; misses (absent points, schema mismatch, errors)
 *  are simply absent from the map. Best-effort: any Qdrant error is logged and
 *  swallowed, returning whatever entries were successfully assembled (likely
 *  empty on a failed retrieve). */
export async function lookupSymbolCacheBatch(
  entries: Array<{ lang: string; blobSha: string }>,
): Promise<Map<string, CachedSymbolEntry>> {
  const result = new Map<string, CachedSymbolEntry>();
  if (entries.length === 0) return result;

  try {
    await ensureSymbolCacheCollection();
    const client = getClient();

    // Dedupe by point id before sending the retrieve. Multiple files with
    // identical (lang, blobSha) collapse to the same id; we only need to ask
    // Qdrant once per unique id and then fan results back out via the key map.
    const idToKey = new Map<string, string>();
    const ids: string[] = [];
    for (const { lang, blobSha } of entries) {
      const key = symbolCacheKey(lang, blobSha);
      const id = pointId(key);
      if (!idToKey.has(id)) {
        idToKey.set(id, key);
        ids.push(id);
      }
    }

    const points = await client.retrieve(SYMBOL_CACHE_COLLECTION, {
      ids,
      with_payload: true,
    });

    for (const point of points) {
      const key = idToKey.get(String(point.id));
      if (!key) continue;
      const payload = point.payload as unknown as StoredPayload | undefined;
      if (!payload) continue;
      // Defensive: schema version is also baked into the point id, so this
      // should always match — but skip stale rows just in case the collection
      // outlives a schema bump in unusual ways.
      if (payload.schemaVersion !== SYMBOL_CACHE_SCHEMA_VERSION) continue;
      result.set(key, {
        lang: payload.lang,
        blobSha: payload.blobSha,
        symbols: payload.symbols,
        rawCalls: payload.rawCalls,
        imports: payload.imports,
      });
    }
  } catch (err) {
    logger.warn("symbol cache batch lookup failed (treating as full miss)", {
      count: entries.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/** Bulk write: upsert many extracted-symbol entries in a single Qdrant call.
 *  Best-effort: any failure is logged and swallowed so cache writes never
 *  break indexing. Uses `wait: false` because callers don't depend on the
 *  write being durable before returning — a missed write just means the next
 *  rebuild does another miss. */
export async function writeSymbolCacheBatch(entries: CachedSymbolEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    await ensureSymbolCacheCollection();
    const client = getClient();

    // Dedupe by point id so a single batch with two files sharing a blob sha
    // doesn't upsert the same point twice (Qdrant accepts it but it's wasted
    // work and could surface as a "duplicate id" warning depending on server).
    const seen = new Set<string>();
    const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
    const storedAt = new Date().toISOString();
    for (const entry of entries) {
      const id = pointId(symbolCacheKey(entry.lang, entry.blobSha));
      if (seen.has(id)) continue;
      seen.add(id);
      const payload: StoredPayload = {
        schemaVersion: SYMBOL_CACHE_SCHEMA_VERSION,
        lang: entry.lang,
        blobSha: entry.blobSha,
        symbols: entry.symbols,
        rawCalls: entry.rawCalls,
        imports: entry.imports,
        storedAt,
      };
      points.push({ id, vector: [0], payload: payload as unknown as Record<string, unknown> });
    }
    if (points.length === 0) return;

    await client.upsert(SYMBOL_CACHE_COLLECTION, { wait: false, points });
  } catch (err) {
    logger.warn("symbol cache batch put failed (continuing without cache)", {
      count: entries.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
