// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChunk } from "../../src/types.js";

const { mockUpsert, mockRetrieve, mockEnsure } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockRetrieve: vi.fn(),
  mockEnsure: vi.fn(),
}));

vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({ upsert: mockUpsert, retrieve: mockRetrieve }),
  ensureEmbeddingCacheCollection: mockEnsure,
}));

import {
  cacheKey,
  EMBEDDING_CACHE_COLLECTION,
  lookupEmbedding,
  putEmbedding,
} from "../../src/services/embedding-cache.js";

const ENV_MODEL = process.env.EMBEDDING_MODEL;
const ENV_DIMS = process.env.EMBEDDING_DIMENSIONS;

const sampleChunks: FileChunk[] = [
  {
    id: "c1",
    filePath: "/repo/a.ts",
    relativePath: "a.ts",
    content: "export const x = 1;",
    startLine: 1,
    endLine: 1,
    language: "typescript",
    type: "code",
  },
];
const sampleVectors = [[0.1, 0.2, 0.3]];

beforeEach(() => {
  mockUpsert.mockReset().mockResolvedValue(undefined);
  mockRetrieve.mockReset().mockResolvedValue([]);
  mockEnsure.mockReset().mockResolvedValue(undefined);
  process.env.EMBEDDING_MODEL = "qwen3-embedding:0.6b";
  process.env.EMBEDDING_DIMENSIONS = "1024";
});

afterEach(() => {
  if (ENV_MODEL === undefined) delete process.env.EMBEDDING_MODEL;
  else process.env.EMBEDDING_MODEL = ENV_MODEL;
  if (ENV_DIMS === undefined) delete process.env.EMBEDDING_DIMENSIONS;
  else process.env.EMBEDDING_DIMENSIONS = ENV_DIMS;
});

describe("cacheKey", () => {
  it("includes content hash, model name, and dimensions", () => {
    const k = cacheKey("abc123");
    expect(k).toContain("abc123");
    expect(k).toContain("qwen3-embedding:0.6b");
    expect(k).toContain("1024");
  });

  it("differs when model changes", () => {
    const k1 = cacheKey("abc123");
    process.env.EMBEDDING_MODEL = "different-model";
    const k2 = cacheKey("abc123");
    expect(k1).not.toBe(k2);
  });

  it("differs when dimensions change", () => {
    const k1 = cacheKey("abc123");
    process.env.EMBEDDING_DIMENSIONS = "768";
    const k2 = cacheKey("abc123");
    expect(k1).not.toBe(k2);
  });

  it("is stable for identical inputs", () => {
    expect(cacheKey("hash-stable")).toBe(cacheKey("hash-stable"));
  });
});

describe("lookupEmbedding", () => {
  it("returns null when no point exists for the hash", async () => {
    mockRetrieve.mockResolvedValue([]);
    expect(await lookupEmbedding("nonexistent-hash")).toBeNull();
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it("returns chunks+vectors when cached", async () => {
    mockRetrieve.mockResolvedValue([
      {
        payload: {
          chunks: sampleChunks,
          vectors: sampleVectors,
          model: "qwen3-embedding:0.6b",
          dimensions: 1024,
          storedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    ]);
    expect(await lookupEmbedding("hash-with-data")).toEqual({
      chunks: sampleChunks,
      vectors: sampleVectors,
    });
  });

  it("looks up in the embedding cache collection", async () => {
    await lookupEmbedding("any-hash");
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockRetrieve.mock.calls[0][0]).toBe(EMBEDDING_CACHE_COLLECTION);
  });

  it("returns null on cache record from a different model (defensive)", async () => {
    mockRetrieve.mockResolvedValue([
      {
        payload: {
          chunks: sampleChunks,
          vectors: sampleVectors,
          model: "old-model",
          dimensions: 1024,
          storedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    ]);
    expect(await lookupEmbedding("hash-with-stale")).toBeNull();
  });

  it("returns null and swallows errors if qdrant lookup throws", async () => {
    mockRetrieve.mockRejectedValue(new Error("qdrant down"));
    expect(await lookupEmbedding("any-hash")).toBeNull();
  });

  it("returns null and swallows errors if ensure throws", async () => {
    mockEnsure.mockRejectedValue(new Error("collection create failed"));
    expect(await lookupEmbedding("any-hash")).toBeNull();
  });
});

describe("putEmbedding", () => {
  it("upserts a single point keyed by cacheKey() into the cache collection", async () => {
    await putEmbedding("hash-1", { chunks: sampleChunks, vectors: sampleVectors });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [collection, body] = mockUpsert.mock.calls[0];
    expect(collection).toBe(EMBEDDING_CACHE_COLLECTION);
    expect(body.points).toHaveLength(1);
    const point = body.points[0];
    expect(point.payload.chunks).toEqual(sampleChunks);
    expect(point.payload.vectors).toEqual(sampleVectors);
    expect(point.payload.model).toBe("qwen3-embedding:0.6b");
    expect(point.payload.dimensions).toBe(1024);
    expect(typeof point.payload.storedAt).toBe("string");
  });

  it("ensures the cache collection before upserting", async () => {
    await putEmbedding("hash-2", { chunks: sampleChunks, vectors: sampleVectors });
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpsert.mock.invocationCallOrder[0],
    );
  });

  it("uses the same point id for the same content hash + model + dimensions", async () => {
    await putEmbedding("same-hash", { chunks: sampleChunks, vectors: sampleVectors });
    await putEmbedding("same-hash", { chunks: sampleChunks, vectors: sampleVectors });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const id1 = mockUpsert.mock.calls[0][1].points[0].id;
    const id2 = mockUpsert.mock.calls[1][1].points[0].id;
    expect(id1).toBe(id2);
  });

  it("does not throw when qdrant upsert errors (best-effort)", async () => {
    mockUpsert.mockRejectedValue(new Error("qdrant down"));
    await expect(
      putEmbedding("h", { chunks: sampleChunks, vectors: sampleVectors }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when ensure errors (best-effort)", async () => {
    mockEnsure.mockRejectedValue(new Error("ensure failed"));
    await expect(
      putEmbedding("h", { chunks: sampleChunks, vectors: sampleVectors }),
    ).resolves.toBeUndefined();
  });
});
