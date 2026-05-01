// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QDRANT_API_KEY, QDRANT_HOST, QDRANT_PORT, QDRANT_URL, resolveQdrantPort } from "../constants.js";
import type { ArtifactIndexState, CodeGraph, FileChunk, SearchResult } from "../types.js";
import { getEmbeddingConfig } from "./embedding-config.js";
import { generateEmbeddings, generateQueryEmbedding, prepareDocumentText } from "./embeddings.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/** Retry an async operation with exponential backoff */
async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

let client: QdrantClient | null = null;

export function getClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient(
      QDRANT_URL
        ? {
            url: QDRANT_URL,
            port: resolveQdrantPort(QDRANT_URL),
            ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
            checkCompatibility: false,
          }
        : {
            host: QDRANT_HOST,
            port: QDRANT_PORT,
            ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
            checkCompatibility: false,
          },
    );
  }
  return client;
}

/** Create a collection if it doesn't exist */
export async function ensureCollection(name: string): Promise<void> {
  const qdrant = getClient();
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === name);

  if (!exists) {
    const { embeddingDimensions } = getEmbeddingConfig();
    await qdrant.createCollection(name, {
      vectors: {
        dense: {
          size: embeddingDimensions,
          distance: "Cosine",
        },
      },
      sparse_vectors: {
        bm25: {
          modifier: "idf",
        },
      },
      optimizers_config: {
        default_segment_number: 2,
      },
      on_disk_payload: true,
    });

    // Create payload indexes for faster filtering
    await qdrant.createPayloadIndex(name, {
      field_name: "filePath",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(name, {
      field_name: "relativePath",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(name, {
      field_name: "language",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(name, {
      field_name: "contentHash",
      field_schema: "keyword",
    });
  }
}

/** Create a payload index on a collection (idempotent — ignores "already exists" errors) */
export async function ensurePayloadIndex(collName: string, fieldName: string): Promise<void> {
  const qdrant = getClient();
  try {
    await qdrant.createPayloadIndex(collName, {
      field_name: fieldName,
      field_schema: "keyword",
    });
  } catch {
    // Index already exists — ignore
  }
}

/** Delete a collection */
export async function deleteCollection(name: string): Promise<void> {
  const qdrant = getClient();
  try {
    logger.warn("Deleting Qdrant collection", { collection: name });
    await qdrant.deleteCollection(name);
    logger.info("Deleted Qdrant collection", { collection: name });
  } catch (err) {
    // collection may not exist
    logger.info("deleteCollection: collection may not exist (ignored)", {
      collection: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** List all codebase, codegraph, and context artifact entries.
 * Codebase and context entries are actual collections; codegraph entries come from metadata. */
export async function listCodebaseCollections(): Promise<string[]> {
  const qdrant = getClient();
  const collections = await qdrant.getCollections();
  const result = collections.collections
    .map((c) => c.name)
    .filter((n) => n.startsWith("codebase_") || n.startsWith("codegraph_") || n.startsWith("context_"));

  // Also check metadata for graph and context entries (stored as metadata points, not real collections)
  try {
    await ensureMetadataCollection();
    const metaPoints = await qdrant.scroll(METADATA_COLLECTION, {
      limit: 100,
      with_payload: true,
    });
    for (const point of metaPoints.points) {
      const collName = point.payload?.collectionName as string | undefined;
      if (
        (collName?.startsWith("codegraph_") || collName?.startsWith("context_")) &&
        !result.includes(collName)
      ) {
        result.push(collName);
      }
    }
  } catch (err) {
    // Metadata collection may not exist yet (expected before first index)
    logger.info("listCodebaseCollections: metadata scroll failed (expected if no projects indexed yet)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/** Upsert chunks into a collection */
export async function upsertChunks(
  collectionName: string,
  chunks: FileChunk[],
  contentHash: string,
): Promise<void> {
  if (chunks.length === 0) return;

  const qdrant = getClient();
  const texts = chunks.map((c) => prepareDocumentText(c.content, c.relativePath));
  const embeddings = await generateEmbeddings(texts);

  const points = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: {
      dense: embeddings[i],
      bm25: {
        text: texts[i],
        model: "qdrant/bm25",
      },
    },
    payload: {
      filePath: chunk.filePath,
      relativePath: chunk.relativePath,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      type: chunk.type,
      contentHash,
    },
  }));

  // Upsert in batches of 100
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    await withRetry(
      () => qdrant.upsert(collectionName, { points: batch }),
      `Qdrant upsert batch ${Math.floor(i / 100) + 1}`,
    );
  }
}

/** Maximum text length (in characters) sent to Qdrant's server-side BM25 tokenizer.
 * Oversized texts are truncated — the dense vector still captures full semantics,
 * and the stored content payload remains full-length for display. */
const MAX_BM25_TEXT_CHARS = 32_000; // ~32KB

/** Upsert pre-embedded points into a collection (no embedding generation).
 * bm25Text is forwarded to Qdrant's server-side BM25 inference (truncated if too long).
 * Returns the number of points that were skipped due to upsert errors. */
export async function upsertPreEmbeddedChunks(
  collectionName: string,
  points: Array<{
    id: string;
    vector: number[];
    bm25Text: string;
    payload: Record<string, unknown>;
  }>,
): Promise<{ pointsSkipped: number }> {
  if (points.length === 0) return { pointsSkipped: 0 };

  const qdrant = getClient();
  const namedPoints = points.map((p) => ({
    id: p.id,
    vector: {
      dense: p.vector,
      bm25: {
        text: p.bm25Text.length > MAX_BM25_TEXT_CHARS
          ? p.bm25Text.slice(0, MAX_BM25_TEXT_CHARS)
          : p.bm25Text,
        model: "qdrant/bm25",
      },
    },
    payload: p.payload,
  }));

  let totalSkipped = 0;

  // Upsert in batches of 100, with per-point fallback on failure
  for (let i = 0; i < namedPoints.length; i += 100) {
    const batch = namedPoints.slice(i, i + 100);
    const batchLabel = `Qdrant upsert batch ${Math.floor(i / 100) + 1}`;
    try {
      await withRetry(
        () => qdrant.upsert(collectionName, { points: batch }),
        batchLabel,
      );
    } catch (batchErr) {
      // Batch failed after retries — fall back to one-by-one to isolate the bad point(s)
      logger.warn(`${batchLabel} failed, falling back to per-point upsert to isolate failures`, {
        error: batchErr instanceof Error ? batchErr.message : String(batchErr),
        pointCount: batch.length,
      });
      let skipped = 0;
      for (const point of batch) {
        try {
          await qdrant.upsert(collectionName, { points: [point] });
        } catch (pointErr) {
          skipped++;
          const filePath = point.payload?.relativePath ?? point.payload?.filePath ?? point.id;
          logger.warn(`Skipping point that failed upsert`, {
            pointId: point.id,
            filePath: String(filePath),
            error: pointErr instanceof Error ? pointErr.message : String(pointErr),
          });
        }
      }
      if (skipped > 0) {
        logger.warn(`${batchLabel}: ${skipped}/${batch.length} points skipped due to errors`);
      }
      totalSkipped += skipped;
    }
  }

  return { pointsSkipped: totalSkipped };
}

/** Resolve the base URL Qdrant should use to fetch its own snapshots during
 *  recover. The recover endpoint pulls the snapshot tarball over HTTP, so the
 *  URL must be reachable from inside the Qdrant process — which is NOT the
 *  same as the client-facing URL when Qdrant is running in a container with
 *  a port mapping (e.g. host `localhost:16333` → container `localhost:6333`).
 *
 *  Resolution order:
 *    1. `QDRANT_INTERNAL_URL` env var — explicit override, preferred for any
 *       deployment where the client can't reach Qdrant via the same URL
 *       Qdrant uses to reach itself (Docker port mapping, k8s, etc).
 *    2. `QDRANT_URL` env var — for cloud/remote Qdrant the public URL is
 *       reachable from the Qdrant pod itself (it's the DNS name everyone
 *       uses), so this is the right default.
 *    3. Heuristic for managed local Docker: when host is `localhost` and the
 *       port is non-default (≠ 6333), assume the host port is a mapping and
 *       use container-internal `http://localhost:6333` instead.
 *    4. Fallback: `<scheme>://<QDRANT_HOST>:<QDRANT_PORT>`. */
function resolveQdrantBaseUrl(): string {
  const override = process.env.QDRANT_INTERNAL_URL;
  if (override) return override.replace(/\/+$/, "");
  if (QDRANT_URL) return QDRANT_URL.replace(/\/+$/, "");
  if (QDRANT_HOST === "localhost" && QDRANT_PORT !== 6333) {
    return "http://localhost:6333";
  }
  const scheme = QDRANT_PORT === 443 ? "https" : "http";
  return `${scheme}://${QDRANT_HOST}:${QDRANT_PORT}`;
}

/** Maximum time to wait for the target's reported point count to catch up to
 *  the source after recover returns. Recover is mostly synchronous, but
 *  Qdrant's reported count can lag by a few hundred ms while segments settle. */
const CLONE_CONVERGENCE_TIMEOUT_MS = 60_000;
const CLONE_CONVERGENCE_POLL_MS = 200;

/** Copy every point (dense + sparse vectors + payload) from `source` into
 *  `target` using Qdrant's snapshot + recover primitives. The target
 *  collection MUST NOT EXIST when this is called — recover auto-creates the
 *  target from the snapshot's schema. Returns the number of points copied.
 *
 *  This is a server-side operation: a snapshot is taken on the source
 *  collection (segment-level tar of the data directory), then recover
 *  downloads that tarball back into the target. No client-mediated paging,
 *  no per-point JSON serialization, no BM25 re-tokenization. ~14× faster
 *  than scroll+upsert on the prod-equivalent 125k-point workload.
 *
 *  Failure semantics:
 *    - createSnapshot or recoverSnapshot errors are propagated. Callers
 *      should catch and treat as "fast path unavailable", optionally
 *      cleaning up any partial target before falling through.
 *    - The source-side snapshot is deleted best-effort in `finally`; a
 *      cleanup failure is logged but does not fail the clone. */
export async function cloneCollectionPoints(source: string, target: string): Promise<number> {
  const qdrant = getClient();

  const sourceInfo = await qdrant.getCollection(source);
  const expectedCount = sourceInfo.points_count ?? 0;

  const snapshotResp = await qdrant.createSnapshot(source);
  const snapshotName = snapshotResp?.name;
  if (snapshotName == null) {
    throw new Error(`cloneCollectionPoints: createSnapshot for "${source}" returned no name`);
  }
  logger.info("cloneCollectionPoints: snapshot created", {
    source,
    snapshotName,
    sizeBytes: snapshotResp?.size,
  });

  try {
    const baseUrl = resolveQdrantBaseUrl();
    const location = `${baseUrl}/collections/${encodeURIComponent(source)}/snapshots/${encodeURIComponent(snapshotName)}`;
    // `api_key` is the credential Qdrant uses to authenticate when fetching
    // the snapshot URL itself — distinct from the api-key header on this
    // recover request. For a single-node deployment they're the same key.
    await qdrant.recoverSnapshot(target, {
      location,
      ...(QDRANT_API_KEY ? { api_key: QDRANT_API_KEY } : {}),
    });

    const deadline = Date.now() + CLONE_CONVERGENCE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = await getCollectionInfo(target);
      const got = info?.pointsCount ?? 0;
      if (got >= expectedCount) {
        logger.info("cloneCollectionPoints (snapshot+recover) complete", {
          source,
          target,
          expectedCount,
          got,
        });
        return got;
      }
      await new Promise((r) => setTimeout(r, CLONE_CONVERGENCE_POLL_MS));
    }
    throw new Error(
      `cloneCollectionPoints: recover from "${source}" to "${target}" did not converge within ${CLONE_CONVERGENCE_TIMEOUT_MS}ms (expected ${expectedCount})`,
    );
  } finally {
    await qdrant.deleteSnapshot(source, snapshotName).catch((err) => {
      logger.warn("cloneCollectionPoints: failed to cleanup source snapshot", {
        source,
        snapshotName,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/** Delete all chunks for a specific file (matched by relativePath) */
export async function deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
  const qdrant = getClient();
  logger.info("Deleting file chunks", { collection: collectionName, relativePath });
  await withRetry(
    () => qdrant.delete(collectionName, {
      filter: {
        must: [{ key: "relativePath", match: { value: relativePath } }],
      },
    }),
    "Qdrant delete chunks",
  );
}

/** Hybrid search: combines dense semantic search with BM25 lexical search via RRF fusion.
 * Dense vector is generated client-side; BM25 inference runs server-side in Qdrant (requires v1.15.2+). */
export async function searchChunks(
  collectionName: string,
  query: string,
  limit: number = 10,
  fileFilter?: string,
  languageFilter?: string,
): Promise<SearchResult[]> {
  const queryVector = await generateQueryEmbedding(query);
  return searchChunksWithVector(collectionName, query, queryVector, limit, fileFilter, languageFilter);
}

/** Internal: hybrid search using a pre-computed dense embedding vector.
 * Avoids recomputing the same embedding when querying multiple collections. */
async function searchChunksWithVector(
  collectionName: string,
  query: string,
  queryVector: number[],
  limit: number,
  fileFilter?: string,
  languageFilter?: string,
): Promise<SearchResult[]> {
  const qdrant = getClient();

  const filter: { must: Array<{ key: string; match: { value: string } }> } = { must: [] };
  if (fileFilter) {
    filter.must.push({ key: "relativePath", match: { value: fileFilter } });
  }
  if (languageFilter) {
    filter.must.push({ key: "language", match: { value: languageFilter } });
  }

  // Fetch more candidates per sub-query so RRF has enough to re-rank
  const prefetchLimit = Math.max(limit * 3, 30);
  const activeFilter = filter.must.length > 0 ? filter : undefined;

  const results = await withRetry(
    () => qdrant.query(collectionName, {
      prefetch: [
        { query: queryVector, using: "dense", limit: prefetchLimit, filter: activeFilter },
        {
          query: { text: query, model: "qdrant/bm25" },
          using: "bm25",
          limit: prefetchLimit,
          filter: activeFilter,
        },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
      filter: activeFilter,
    }),
    "Qdrant hybrid search",
  );

  return results.points.map((r) => ({
    filePath: r.payload?.filePath as string,
    relativePath: r.payload?.relativePath as string,
    content: r.payload?.content as string,
    startLine: r.payload?.startLine as number,
    endLine: r.payload?.endLine as number,
    language: r.payload?.language as string,
    score: r.score,
  }));
}

/** Merge results from multiple collection queries using client-side Reciprocal Rank Fusion.
 * Deduplicates by `label::relativePath` so that files with the same relative path
 * in different projects are kept as separate hits. Within a single project,
 * the first (higher-priority) occurrence wins on conflict.
 * Exported for unit testing. */
export function mergeMultiCollectionResults(
  collectionResults: Array<{ label: string; results: SearchResult[] }>,
  limit: number,
): SearchResult[] {
  const RRF_K = 60;
  const scored = new Map<string, SearchResult & { rrfScore: number }>();

  for (const { label, results } of collectionResults) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      const key = `${label}::${r.relativePath}`;
      const rrfContribution = 1 / (RRF_K + rank + 1);

      const existing = scored.get(key);
      if (existing) {
        existing.rrfScore += rrfContribution;
        // Keep the version from the higher-priority (earlier) collection
      } else {
        scored.set(key, { ...r, project: label, rrfScore: rrfContribution });
      }
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(({ rrfScore, ...result }) => ({
      ...result,
      score: rrfScore,
    }));
}

/** Search across multiple collections in parallel with client-side RRF fusion and deduplication.
 * Each collection's results are queried independently, then merged using Reciprocal Rank Fusion.
 * When the same relativePath appears in multiple collections, the result from the
 * earlier (higher-priority) collection wins.
 *
 * @param collections - Array of { name, label } where label identifies the source project
 *   in results. Order defines priority for deduplication (first wins).
 * @param query - Natural language search query.
 * @param limit - Maximum total results to return after merge.
 * @param fileFilter - Optional relativePath filter applied to every collection.
 * @param languageFilter - Optional language filter applied to every collection.
 */
export async function searchMultipleCollections(
  collections: Array<{ name: string; label: string }>,
  query: string,
  limit: number = 10,
  fileFilter?: string,
  languageFilter?: string,
): Promise<SearchResult[]> {
  if (collections.length === 0) return [];
  if (collections.length === 1) {
    const results = await searchChunks(collections[0].name, query, limit, fileFilter, languageFilter);
    return results.map((r) => ({ ...r, project: collections[0].label }));
  }

  // Compute the dense embedding once for all collections
  const queryVector = await generateQueryEmbedding(query);

  // Query all collections in parallel, requesting extra candidates for RRF re-ranking
  const perCollectionLimit = Math.max(limit * 2, 20);
  const collectionResults: Array<{ label: string; results: SearchResult[] }> = [];

  const allResults = await Promise.all(
    collections.map(async ({ name, label }) => {
      try {
        const results = await searchChunksWithVector(name, query, queryVector, perCollectionLimit, fileFilter, languageFilter);
        return { label, results };
      } catch (err) {
        logger.warn("searchMultipleCollections: collection query failed, skipping", {
          collection: name,
          error: err instanceof Error ? err.message : String(err),
        });
        return { label, results: [] as SearchResult[] };
      }
    }),
  );

  collectionResults.push(...allResults);

  return mergeMultiCollectionResults(collectionResults, limit);
}

/** Hybrid search with arbitrary payload filters.
 * Used by context artifacts to filter by artifactName. */
export async function searchChunksWithFilter(
  collectionName: string,
  query: string,
  limit: number,
  filters: Array<{ key: string; value: string }>,
): Promise<SearchResult[]> {
  const qdrant = getClient();
  const queryVector = await generateQueryEmbedding(query);

  const filter = filters.length > 0
    ? { must: filters.map((f) => ({ key: f.key, match: { value: f.value } })) }
    : undefined;

  const prefetchLimit = Math.max(limit * 3, 30);

  const results = await withRetry(
    () => qdrant.query(collectionName, {
      prefetch: [
        { query: queryVector, using: "dense", limit: prefetchLimit, filter },
        {
          query: { text: query, model: "qdrant/bm25" },
          using: "bm25",
          limit: prefetchLimit,
          filter,
        },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
      filter,
    }),
    "Qdrant hybrid search (filtered)",
  );

  return results.points.map((r) => ({
    filePath: r.payload?.filePath as string,
    relativePath: r.payload?.relativePath as string,
    content: r.payload?.content as string,
    startLine: r.payload?.startLine as number,
    endLine: r.payload?.endLine as number,
    language: r.payload?.language as string,
    score: r.score,
  }));
}

/** Get collection info.
 * Returns the collection info if it exists, null if the collection does not exist,
 * or throws an error if the request fails for any other reason (network, timeout, etc.).
 * This distinction is critical: callers must NOT treat transient errors as "collection missing". */
export async function getCollectionInfo(name: string): Promise<{
  pointsCount: number;
  status: string;
} | null> {
  const qdrant = getClient();
  try {
    const info = await qdrant.getCollection(name);
    return {
      pointsCount: info.points_count ?? 0,
      status: info.status,
    };
  } catch (err: unknown) {
    // Only return null for "not found" — propagate all other errors
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    if (status === 404 || message.includes("Not found") || message.includes("doesn't exist") || message.includes("not found")) {
      return null;
    }
    logger.warn("getCollectionInfo failed with unexpected error (propagating)", { collection: name, error: message });
    throw err;
  }
}

// ── Project metadata collection ──────────────────────────────────────────

export const METADATA_COLLECTION = "socraticode_metadata";

/** Cached flag: once the metadata collection is confirmed to exist, skip re-checking */
let metadataCollectionReady = false;

/** Reset the metadata collection readiness cache (for testing only) */
export function resetMetadataCollectionCache(): void {
  metadataCollectionReady = false;
}

/** Ensure the metadata collection exists (idempotent, cached after first success) */
export async function ensureMetadataCollection(): Promise<void> {
  if (metadataCollectionReady) return;

  const qdrant = getClient();
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === METADATA_COLLECTION);
  if (!exists) {
    // Metadata collection uses a dummy 1-dim vector since Qdrant requires vectors
    await qdrant.createCollection(METADATA_COLLECTION, {
      vectors: { size: 1, distance: "Cosine" },
      on_disk_payload: true,
    });
    await qdrant.createPayloadIndex(METADATA_COLLECTION, {
      field_name: "collectionName",
      field_schema: "keyword",
    });
    logger.info("Created metadata collection");
  }

  metadataCollectionReady = true;
}

// ── Embedding cache collection ───────────────────────────────────────────

const EMBEDDING_CACHE_COLLECTION = "socraticode_embedding_cache";

/** Cached flag: once the embedding cache collection is confirmed to exist, skip re-checking */
let embeddingCacheCollectionReady = false;

/** Reset the embedding cache collection readiness cache (for testing only) */
export function resetEmbeddingCacheCollectionCache(): void {
  embeddingCacheCollectionReady = false;
}

/** Ensure the embedding cache collection exists (idempotent, cached after first success).
 *  The collection stores (chunks, vectors) keyed by content hash + model + dimensions
 *  and is never searched, so it uses a 1-dim dummy vector (Qdrant requires vectors).
 *  Handles concurrent creation: the indexer's per-file scan calls this in parallel
 *  via Promise.all, so multiple callers can race past the existence check. We swallow
 *  the resulting "Conflict" / "already exists" error since either outcome leaves the
 *  collection in the same usable state. */
export async function ensureEmbeddingCacheCollection(): Promise<void> {
  if (embeddingCacheCollectionReady) return;

  const qdrant = getClient();
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === EMBEDDING_CACHE_COLLECTION);
  if (!exists) {
    try {
      await qdrant.createCollection(EMBEDDING_CACHE_COLLECTION, {
        vectors: { size: 1, distance: "Cosine" },
        on_disk_payload: true,
      });
      logger.info("Created embedding cache collection");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|conflict/i.test(msg)) throw err;
      // Another concurrent caller created it — that's fine.
    }
  }

  embeddingCacheCollectionReady = true;
}

/** Generate a stable UUID from a collection name (for Qdrant point ID).
 *  Uses SHA-256 to avoid collision risk inherent in simpler hashes (e.g. djb2). */
export function metadataPointId(collName: string): string {
  const hash = createHash("sha256").update(collName).digest("hex").slice(0, 32);
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Indexing status persisted in Qdrant metadata */
export type IndexingStatus = "in-progress" | "completed";

/** Optional extras for {@link saveProjectMetadata}. Forward-compatible bag for
 *  fast-path indexing data that not every caller has on hand. */
export interface SaveMetadataExtras {
  /** Map of repo-relative path → git blob SHA-1 for the indexed snapshot.
   *  Persisted as JSON on the metadata point so future runs can compare git
   *  trees without re-hashing every file. */
  gitBlobShas?: Map<string, string>;
}

/** Save project metadata and file hashes to Qdrant */
export async function saveProjectMetadata(
  collName: string,
  projectPath: string,
  filesTotal: number,
  filesIndexed: number,
  fileHashes: Map<string, string>,
  indexingStatus: IndexingStatus,
  extras?: SaveMetadataExtras,
): Promise<void> {
  await ensureMetadataCollection();
  const qdrant = getClient();
  const id = metadataPointId(collName);

  const hashObj: Record<string, string> = {};
  for (const [k, v] of fileHashes) {
    hashObj[k] = v;
  }

  const payload: Record<string, unknown> = {
    collectionName: collName,
    projectPath,
    lastIndexedAt: new Date().toISOString(),
    filesTotal,
    filesIndexed,
    fileHashes: JSON.stringify(hashObj),
    indexingStatus,
  };

  if (extras?.gitBlobShas) {
    const blobObj: Record<string, string> = {};
    for (const [k, v] of extras.gitBlobShas) {
      blobObj[k] = v;
    }
    payload.gitBlobShas = JSON.stringify(blobObj);
  }

  await qdrant.upsert(METADATA_COLLECTION, {
    points: [
      {
        id,
        vector: [0],
        payload,
      },
    ],
  });

  logger.info("Saved project metadata", { collName, projectPath, filesTotal, filesIndexed, indexingStatus });
}

/** Load file hashes for a project from Qdrant.
 * Returns the hash map if found, null if the metadata point doesn't exist,
 * or throws on transient/unexpected errors so callers can distinguish
 * "no metadata" from "Qdrant unreachable". */
export async function loadProjectHashes(collName: string): Promise<Map<string, string> | null> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(collName);

    const points = await qdrant.retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: true,
    });

    if (points.length === 0) return null;

    const payload = points[0].payload;
    if (!payload?.fileHashes) return null;

    const hashObj = JSON.parse(payload.fileHashes as string) as Record<string, string>;
    return new Map(Object.entries(hashObj));
  } catch (err) {
    logger.warn("loadProjectHashes failed (propagating)", {
      collName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Load git blob shas for a project from Qdrant.
 *
 * Returns null when:
 *   - the metadata point doesn't exist
 *   - the collection's metadata doesn't carry a `gitBlobShas` key (older
 *     collections created before this feature shipped)
 *   - the persisted payload is malformed (logged as a warning so the
 *     stale entry shows up in diagnostics, but the fast-path safely
 *     falls back to a normal scan)
 *
 * Network/Qdrant errors propagate so callers can distinguish "no data"
 * from "Qdrant unreachable". */
export async function loadProjectGitBlobShas(collName: string): Promise<Map<string, string> | null> {
  await ensureMetadataCollection();
  const qdrant = getClient();
  const id = metadataPointId(collName);

  const points = await qdrant.retrieve(METADATA_COLLECTION, {
    ids: [id],
    with_payload: true,
  });

  if (points.length === 0) return null;

  const payload = points[0].payload;
  const raw = payload?.gitBlobShas;
  if (typeof raw !== "string") return null;

  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch (err) {
    logger.warn("loadProjectGitBlobShas: malformed gitBlobShas payload", {
      collName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Result of {@link findSiblingMetadata}: the candidate sibling collection plus
 *  enough hash material for the caller to seed a fast-path index. */
export interface SiblingMetadata {
  collectionName: string;
  fileHashes: Map<string, string>;
  gitBlobShas: Map<string, string>;
  matchCount: number;
}

/** Find the sibling collection (different collection name, same projectPath)
 *  whose stored gitBlobShas overlap most with the supplied `currentBlobShas`.
 *  `excludeCollection` lets the caller skip the in-progress target so it isn't
 *  considered as its own sibling.
 *
 *  Implementation: scrolls METADATA_COLLECTION with a payload filter on
 *  projectPath, materializes candidates client-side (project metadata is
 *  dozens of points per host, not millions — scanning is fine), and returns
 *  the best match plus its file/blob hash maps. Returns null when no
 *  candidate exists for the projectPath, when every candidate is excluded,
 *  or when no candidate has any overlap with `currentBlobShas`. */
export async function findSiblingMetadata(
  projectPath: string,
  currentBlobShas: Map<string, string>,
  excludeCollection?: string,
): Promise<SiblingMetadata | null> {
  await ensureMetadataCollection();
  const qdrant = getClient();

  let bestMatch = -1;
  let best: SiblingMetadata | null = null;
  let offset: string | number | Record<string, unknown> | undefined;

  while (true) {
    const page = await qdrant.scroll(METADATA_COLLECTION, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [{ key: "projectPath", match: { value: projectPath } }],
      },
    });

    for (const point of page.points) {
      const payload = point.payload;
      const collName = payload?.collectionName;
      if (typeof collName !== "string") continue;
      if (excludeCollection !== undefined && collName === excludeCollection) continue;

      const blobsRaw = payload?.gitBlobShas;
      if (typeof blobsRaw !== "string") continue;
      let blobs: Map<string, string>;
      try {
        blobs = new Map(Object.entries(JSON.parse(blobsRaw) as Record<string, string>));
      } catch {
        continue;
      }

      let matchCount = 0;
      for (const [path, sha] of currentBlobShas) {
        if (blobs.get(path) === sha) matchCount++;
      }

      if (matchCount > bestMatch) {
        const hashesRaw = payload?.fileHashes;
        let fileHashes = new Map<string, string>();
        if (typeof hashesRaw === "string") {
          try {
            fileHashes = new Map(Object.entries(JSON.parse(hashesRaw) as Record<string, string>));
          } catch {
            continue;
          }
        }
        bestMatch = matchCount;
        best = { collectionName: collName, fileHashes, gitBlobShas: blobs, matchCount };
      }
    }

    if (page.next_page_offset == null) break;
    offset = page.next_page_offset as string | number | Record<string, unknown>;
  }

  return bestMatch > 0 ? best : null;
}

/** Get project metadata (for list display).
 * Returns null if metadata doesn't exist or on any error (logged as warning). */
export async function getProjectMetadata(collName: string): Promise<{
  projectPath: string;
  lastIndexedAt: string;
  filesTotal: number;
  filesIndexed: number;
  indexingStatus: IndexingStatus;
} | null> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(collName);

    const points = await qdrant.retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: true,
    });

    if (points.length === 0) return null;

    const payload = points[0].payload;
    return {
      projectPath: payload?.projectPath as string,
      lastIndexedAt: payload?.lastIndexedAt as string,
      filesTotal: (payload?.filesTotal as number) ?? (payload?.filesIndexed as number) ?? 0,
      filesIndexed: (payload?.filesIndexed as number) ?? 0,
      indexingStatus: (payload?.indexingStatus as IndexingStatus) ?? "completed",
    };
  } catch (err) {
    logger.warn("getProjectMetadata failed (returning null)", {
      collName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Delete project metadata.
 * Errors are logged but not propagated (best-effort deletion). */
export async function deleteProjectMetadata(collName: string): Promise<void> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(collName);
    logger.warn("Deleting project metadata", { collName });
    await qdrant.delete(METADATA_COLLECTION, { points: [id] });
  } catch (err) {
    logger.warn("deleteProjectMetadata failed (ignored)", {
      collName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Code graph persistence ──────────────────────────────────────────────

/** Save a code graph to Qdrant as a single metadata point */
export async function saveGraphData(
  graphCollName: string,
  projectPath: string,
  graph: CodeGraph,
): Promise<void> {
  await ensureMetadataCollection();
  const qdrant = getClient();
  const id = metadataPointId(graphCollName);

  await qdrant.upsert(METADATA_COLLECTION, {
    points: [
      {
        id,
        vector: [0],
        payload: {
          collectionName: graphCollName,
          projectPath,
          lastBuiltAt: new Date().toISOString(),
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          graphData: JSON.stringify(graph),
        },
      },
    ],
  });

  logger.info("Saved code graph", { graphCollName, projectPath, nodes: graph.nodes.length, edges: graph.edges.length });
}

/** Load a code graph from Qdrant.
 * Returns null if no graph exists or on any error (logged as warning). */
export async function loadGraphData(graphCollName: string): Promise<CodeGraph | null> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(graphCollName);

    const points = await qdrant.retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: true,
    });

    if (points.length === 0) return null;

    const payload = points[0].payload;
    if (!payload?.graphData) return null;

    return JSON.parse(payload.graphData as string) as CodeGraph;
  } catch (err) {
    logger.warn("loadGraphData failed (returning null)", {
      graphCollName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Get graph metadata (for list/status display).
 * Returns null if no graph exists or on any error (logged as warning). */
export async function getGraphMetadata(graphCollName: string): Promise<{
  projectPath: string;
  lastBuiltAt: string;
  nodeCount: number;
  edgeCount: number;
} | null> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(graphCollName);

    const points = await qdrant.retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: true,
    });

    if (points.length === 0) return null;

    const payload = points[0].payload;
    return {
      projectPath: payload?.projectPath as string,
      lastBuiltAt: payload?.lastBuiltAt as string,
      nodeCount: payload?.nodeCount as number,
      edgeCount: payload?.edgeCount as number,
    };
  } catch (err) {
    logger.warn("getGraphMetadata failed (returning null)", {
      graphCollName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Delete graph data from metadata.
 * Errors are logged but not propagated (best-effort deletion). */
export async function deleteGraphData(graphCollName: string): Promise<void> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(graphCollName);
    logger.warn("Deleting graph data", { graphCollName });
    await qdrant.delete(METADATA_COLLECTION, { points: [id] });
  } catch (err) {
    logger.warn("deleteGraphData failed (ignored)", {
      graphCollName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Context artifact metadata ────────────────────────────────────────────

/** Save context artifact metadata to Qdrant */
export async function saveContextMetadata(
  contextCollName: string,
  projectPath: string,
  artifacts: ArtifactIndexState[],
): Promise<void> {
  await ensureMetadataCollection();
  const qdrant = getClient();
  const id = metadataPointId(contextCollName);

  await qdrant.upsert(METADATA_COLLECTION, {
    points: [
      {
        id,
        vector: [0],
        payload: {
          collectionName: contextCollName,
          projectPath,
          lastIndexedAt: new Date().toISOString(),
          artifactCount: artifacts.length,
          artifacts: JSON.stringify(artifacts),
        },
      },
    ],
  });

  logger.info("Saved context artifact metadata", { contextCollName, projectPath, artifactCount: artifacts.length });
}

/** Load context artifact metadata from Qdrant.
 * Returns null if no metadata exists or on any error (logged as warning). */
export async function loadContextMetadata(contextCollName: string): Promise<ArtifactIndexState[] | null> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(contextCollName);

    const points = await qdrant.retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: true,
    });

    if (points.length === 0) return null;

    const payload = points[0].payload;
    if (!payload?.artifacts) return null;

    return JSON.parse(payload.artifacts as string) as ArtifactIndexState[];
  } catch (err) {
    logger.warn("loadContextMetadata failed (returning null)", {
      contextCollName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Get context collection metadata (for list/status display).
 * Returns null if no metadata exists or on any error (logged as warning). */
export async function getContextMetadata(contextCollName: string): Promise<{
  projectPath: string;
  lastIndexedAt: string;
  artifactCount: number;
} | null> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(contextCollName);

    const points = await qdrant.retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: true,
    });

    if (points.length === 0) return null;

    const payload = points[0].payload;
    return {
      projectPath: payload?.projectPath as string,
      lastIndexedAt: payload?.lastIndexedAt as string,
      artifactCount: (payload?.artifactCount as number) ?? 0,
    };
  } catch (err) {
    logger.warn("getContextMetadata failed (returning null)", {
      contextCollName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Delete context artifact metadata.
 * Errors are logged but not propagated (best-effort deletion). */
export async function deleteContextMetadata(contextCollName: string): Promise<void> {
  try {
    await ensureMetadataCollection();
    const qdrant = getClient();
    const id = metadataPointId(contextCollName);
    logger.warn("Deleting context metadata", { contextCollName });
    await qdrant.delete(METADATA_COLLECTION, { points: [id] });
  } catch (err) {
    logger.warn("deleteContextMetadata failed (ignored)", {
      contextCollName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Delete all chunks for a specific artifact within a collection */
export async function deleteArtifactChunks(collectionName: string, artifactName: string): Promise<void> {
  const qdrant = getClient();
  logger.info("Deleting artifact chunks", { collection: collectionName, artifactName });
  await withRetry(
    () => qdrant.delete(collectionName, {
      filter: {
        must: [{ key: "artifactName", match: { value: artifactName } }],
      },
    }),
    "Qdrant delete artifact chunks",
  );
}
