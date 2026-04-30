// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { createHash } from "node:crypto";
import type { FileChunk } from "../types.js";
import { logger } from "./logger.js";
import { ensureEmbeddingCacheCollection, getClient } from "./qdrant.js";

export const EMBEDDING_CACHE_COLLECTION = "socraticode_embedding_cache";

export interface CachedEmbedding {
  chunks: FileChunk[];
  vectors: number[][];
}

interface StoredPayload extends CachedEmbedding {
  model: string;
  dimensions: number;
  storedAt: string;
}

// Stable lookup key combining content hash with the embedding-model context.
// Different models or dimensions produce different cache slots, so the cache
// stays correct across model upgrades (vectors aren't compatible across models).
export function cacheKey(contentHash: string): string {
  const model = process.env.EMBEDDING_MODEL ?? "default";
  const dims = process.env.EMBEDDING_DIMENSIONS ?? "0";
  return `${contentHash}:${model}:${dims}`;
}

// Derives a UUID-shaped point ID from a cache key. Mirrors the convention
// used by `metadataPointId` in qdrant.ts so the cache collection plays well
// with existing tooling.
function pointId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Look up cached chunks+vectors for a given content hash. Returns null when
// the entry is absent, when the stored model doesn't match the current
// EMBEDDING_MODEL env (defensive: cacheKey already isolates by model, but we
// double-check the payload), or on any error. Best-effort: never throws.
//
// Thin wrapper over lookupEmbeddings — the bulk variant is the preferred
// path for the indexer batch loop because it collapses N retrieve round-trips
// into one. Single-key callers stay supported for ad-hoc lookups.
export async function lookupEmbedding(contentHash: string): Promise<CachedEmbedding | null> {
  const map = await lookupEmbeddings([contentHash]);
  return map.get(contentHash) ?? null;
}

// Bulk variant: look up many content hashes in a single Qdrant retrieve.
// Returns a map keyed by contentHash; misses (absent points, model mismatch,
// errors) are simply absent from the map. Callers should treat absence as a
// cache miss and fall through to fresh chunking + embedding.
//
// Best-effort like the single-key form: any Qdrant error is logged and
// swallowed, returning whatever entries were successfully assembled (likely
// empty on a failed retrieve).
export async function lookupEmbeddings(
  contentHashes: string[],
): Promise<Map<string, CachedEmbedding>> {
  const result = new Map<string, CachedEmbedding>();
  if (contentHashes.length === 0) return result;

  try {
    await ensureEmbeddingCacheCollection();
    const client = getClient();

    // Dedupe by point id before sending the retrieve. Multiple files with
    // identical content collapse to the same id; we only need to ask Qdrant
    // once per unique id and then fan results back out via the hash map.
    const idToHash = new Map<string, string>();
    const ids: string[] = [];
    for (const hash of contentHashes) {
      const id = pointId(cacheKey(hash));
      if (!idToHash.has(id)) {
        idToHash.set(id, hash);
        ids.push(id);
      }
    }

    const points = await client.retrieve(EMBEDDING_CACHE_COLLECTION, {
      ids,
      with_payload: true,
    });

    const expectedModel = process.env.EMBEDDING_MODEL;
    for (const point of points) {
      const hash = idToHash.get(String(point.id));
      if (!hash) continue;
      const payload = point.payload as unknown as StoredPayload | undefined;
      if (!payload) continue;
      if (expectedModel && payload.model !== expectedModel) continue;
      result.set(hash, { chunks: payload.chunks, vectors: payload.vectors });
    }
  } catch (err) {
    logger.warn("embedding cache batch lookup failed (treating as full miss)", {
      count: contentHashes.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

// Store chunks+vectors keyed by content hash. Best-effort: any failure is
// logged and swallowed so cache writes never break indexing.
export async function putEmbedding(
  contentHash: string,
  data: CachedEmbedding,
): Promise<void> {
  try {
    await ensureEmbeddingCacheCollection();
    const client = getClient();
    const key = cacheKey(contentHash);
    const id = pointId(key);
    const payload: StoredPayload = {
      chunks: data.chunks,
      vectors: data.vectors,
      model: process.env.EMBEDDING_MODEL ?? "default",
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 0),
      storedAt: new Date().toISOString(),
    };
    await client.upsert(EMBEDDING_CACHE_COLLECTION, {
      points: [{ id, vector: [0], payload: payload as unknown as Record<string, unknown> }],
    });
  } catch (err) {
    logger.warn("embedding cache put failed (continuing without cache)", {
      contentHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
