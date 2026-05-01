// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureQdrantReady } from "../../src/services/docker.js";
import { getEmbeddingConfig } from "../../src/services/embedding-config.js";
import { ensureOllamaReady } from "../../src/services/ollama.js";
import {
  cloneCollectionPoints,
  deleteCollection,
  deleteFileChunks,
  deleteProjectMetadata,
  ensureCollection,
  ensureMetadataCollection,
  findSiblingMetadata,
  getClient,
  getCollectionInfo,
  getProjectMetadata,
  listCodebaseCollections,
  loadProjectGitBlobShas,
  loadProjectHashes,
  METADATA_COLLECTION,
  metadataPointId,
  saveProjectMetadata,
  searchChunks,
  upsertChunks,
  upsertPreEmbeddedChunks,
} from "../../src/services/qdrant.js";
import type { FileChunk } from "../../src/types.js";
import { isDockerAvailable } from "../helpers/fixtures.js";
import { deleteTestCollection, waitForOllama, waitForQdrant } from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();
const TEST_COLLECTION = "codebase_test_qdrant_integration";

describe.skipIf(!dockerAvailable)("qdrant service", () => {
  beforeAll(async () => {
    await ensureQdrantReady();
    await ensureOllamaReady();
    await waitForQdrant();
    await waitForOllama();

    // Clean up from any previous test run
    await deleteTestCollection(TEST_COLLECTION);
  });

  afterAll(async () => {
    await deleteTestCollection(TEST_COLLECTION);
  });

  describe("collection management", () => {
    it("creates a collection with correct dimensions", async () => {
      await ensureCollection(TEST_COLLECTION);
      const info = await getCollectionInfo(TEST_COLLECTION);

      expect(info).toBeDefined();
      expect(info?.status).toBe("green");
    });

    it("is idempotent — creating an existing collection does not error", async () => {
      await expect(ensureCollection(TEST_COLLECTION)).resolves.not.toThrow();
    });

    it("lists collections including the test collection", async () => {
      const collections = await listCodebaseCollections();
      expect(collections).toContain(TEST_COLLECTION);
    });

    it("returns collection info", async () => {
      const info = await getCollectionInfo(TEST_COLLECTION);
      expect(info).toBeDefined();
      expect(info?.pointsCount).toBe(0); // no data yet
    });

    it("returns null info for non-existent collection", async () => {
      const info = await getCollectionInfo("nonexistent_collection_xyz");
      expect(info).toBeNull();
    });
  });

  describe("chunk upsert and search with real embeddings", () => {
    const chunks: FileChunk[] = [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        filePath: "/project/src/auth.ts",
        relativePath: "src/auth.ts",
        content:
          "export function authenticateUser(token: string): boolean {\n  // Validate JWT token and check permissions\n  const parts = token.split('.');\n  return parts.length === 3;\n}",
        startLine: 1,
        endLine: 5,
        language: "typescript",
        type: "code",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        filePath: "/project/src/math.ts",
        relativePath: "src/math.ts",
        content:
          "export function fibonacci(n: number): number {\n  if (n <= 0) return 0;\n  if (n === 1) return 1;\n  let prev = 0, curr = 1;\n  for (let i = 2; i <= n; i++) {\n    [prev, curr] = [curr, prev + curr];\n  }\n  return curr;\n}",
        startLine: 1,
        endLine: 9,
        language: "typescript",
        type: "code",
      },
      {
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        filePath: "/project/lib/data.py",
        relativePath: "lib/data.py",
        content:
          'def load_json_file(filepath: str) -> dict:\n    """Load and parse a JSON file from disk."""\n    with open(filepath, "r") as f:\n        return json.load(f)',
        startLine: 1,
        endLine: 4,
        language: "python",
        type: "code",
      },
    ];

    const _embeddings: number[][] = [];

    it("upserts chunks with real embeddings (generated internally)", async () => {
      await upsertChunks(TEST_COLLECTION, chunks, "test-content-hash");

      // Verify points were created
      const info = await getCollectionInfo(TEST_COLLECTION);
      expect(info).toBeDefined();
      expect(info?.pointsCount).toBe(3);
    });

    it("searches for authentication-related code", async () => {
      const results = await searchChunks(
        TEST_COLLECTION,
        "user authentication with JWT tokens",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      // The auth.ts chunk should rank highest for auth-related queries
      expect(results[0].relativePath).toBe("src/auth.ts");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].content).toContain("authenticateUser");
    });

    it("searches for mathematical algorithms", async () => {
      const results = await searchChunks(
        TEST_COLLECTION,
        "fibonacci sequence calculation algorithm",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      // The math.ts chunk should rank highest for math queries
      expect(results[0].relativePath).toBe("src/math.ts");
      expect(results[0].content).toContain("fibonacci");
    });

    it("searches for data loading utilities", async () => {
      const results = await searchChunks(
        TEST_COLLECTION,
        "load and parse JSON data from file",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      // The data.py chunk should rank highest
      expect(results[0].relativePath).toBe("lib/data.py");
    });

    it("supports limit parameter", async () => {
      const results = await searchChunks(TEST_COLLECTION, "code", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("supports file filter", async () => {
      const results = await searchChunks(
        TEST_COLLECTION,
        "function",
        10,
        "auth",
      );

      // Only auth.ts should match the file filter
      for (const r of results) {
        expect(r.relativePath).toContain("auth");
      }
    });

    it("supports language filter", async () => {
      const results = await searchChunks(
        TEST_COLLECTION,
        "function",
        10,
        undefined,
        "python",
      );

      for (const r of results) {
        expect(r.language).toBe("python");
      }
    });

    it("returns empty results for unrelated queries in filtered search", async () => {
      const results = await searchChunks(
        TEST_COLLECTION,
        "authentication",
        10,
        undefined,
        "python",
      );

      // Should return python results (only data.py), even though
      // the query is more related to auth.ts
      for (const r of results) {
        expect(r.language).toBe("python");
      }
    });
  });

  describe("delete file chunks", () => {
    it("deletes chunks for a specific file", async () => {
      await deleteFileChunks(TEST_COLLECTION, "lib/data.py");

      const info = await getCollectionInfo(TEST_COLLECTION);
      expect(info?.pointsCount).toBe(2); // 2 remaining
    });
  });

  describe("metadata collection", () => {
    const metadataCollection = TEST_COLLECTION; // reuse the test collection for metadata
    const projectPath = "/test/project/path";

    it("saves project metadata", async () => {
      const fileHashes = new Map<string, string>([
        ["src/auth.ts", "hash-auth"],
        ["src/math.ts", "hash-math"],
      ]);

      await saveProjectMetadata(metadataCollection, projectPath, 42, 2, fileHashes, "completed");

      const metadata = await getProjectMetadata(metadataCollection);
      expect(metadata).toBeDefined();
      expect(metadata?.projectPath).toBe(projectPath);
      expect(metadata?.filesTotal).toBe(42);
      expect(metadata?.filesIndexed).toBe(2);
    });

    it("loads project hashes", async () => {
      const hashes = await loadProjectHashes(metadataCollection);
      // Initially might be empty or contain entries based on implementation
      expect(hashes).toBeDefined();
      expect(typeof hashes).toBe("object");
    });

    it("can delete project metadata", async () => {
      await deleteProjectMetadata(metadataCollection);
      // After deletion, metadata should be gone
      const metadata = await getProjectMetadata(metadataCollection);
      expect(metadata).toBeNull();
    });

    it("round-trips gitBlobShas through saveProjectMetadata + loadProjectGitBlobShas", async () => {
      const collection = "test_qdrant_gitblob_roundtrip";
      const projectPath = "/tmp/fixture";
      await ensureCollection(collection, 1024);
      try {
        const fileHashes = new Map([["a.ts", "sha256-aaa"]]);
        const gitBlobShas = new Map([["a.ts", "0123456789012345678901234567890123456789"]]);
        await saveProjectMetadata(collection, projectPath, 1, 1, fileHashes, "completed", { gitBlobShas });
        const loaded = await loadProjectGitBlobShas(collection);
        expect(loaded).not.toBeNull();
        if (loaded == null) throw new Error("loaded was null");
        expect(loaded.get("a.ts")).toBe("0123456789012345678901234567890123456789");
      } finally {
        await deleteCollection(collection);
      }
    });
  });

  describe("cloneCollectionPoints", () => {
    it(
      "clones all points via snapshot + recover",
      async () => {
        const source = "test_clone_source";
        const target = "test_clone_target";
        const dims = getEmbeddingConfig().embeddingDimensions;
        try {
          await ensureCollection(source);
          // Do NOT ensureCollection(target) — recover auto-creates the
          // target collection from the snapshot's schema. Pre-creating
          // would cause recover to fail.

          // 300 points is plenty to exercise the snapshot/recover round
          // trip end-to-end. Vector values are arbitrary — they just need
          // to be the configured dimensionality so the collection accepts
          // them.
          const denseVector = Array.from({ length: dims }, () => 0.1);
          const points = Array.from({ length: 300 }, (_, i) => ({
            id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
            vector: denseVector,
            bm25Text: `point ${i}`,
            payload: { idx: i, relativePath: `file-${i}.ts` },
          }));
          await upsertPreEmbeddedChunks(source, points);

          const cloned = await cloneCollectionPoints(source, target);
          expect(cloned).toBe(300);

          const targetInfo = await getCollectionInfo(target);
          expect(targetInfo).not.toBeNull();
          if (targetInfo == null) throw new Error("targetInfo was null");
          expect(targetInfo.pointsCount).toBe(300);
        } finally {
          await deleteCollection(source).catch(() => {});
          await deleteCollection(target).catch(() => {});
        }
      },
      120_000,
    );
  });

  describe("findSiblingMetadata", () => {
    it(
      "returns the most-overlapping sibling for a project path",
      async () => {
        const projA = "project-a-1";
        const projA2 = "project-a-2";
        const projB = "project-b-1";
        const fakePath = "/tmp/findsibling-fixture";

        await ensureMetadataCollection();
        await saveProjectMetadata(
          projA,
          fakePath,
          1,
          1,
          new Map([["a.ts", "h1"]]),
          "completed",
          {
            gitBlobShas: new Map([
              ["a.ts", "00".repeat(20)],
              ["b.ts", "11".repeat(20)],
            ]),
          },
        );
        await saveProjectMetadata(
          projA2,
          fakePath,
          1,
          1,
          new Map([["a.ts", "h1"]]),
          "completed",
          { gitBlobShas: new Map([["a.ts", "00".repeat(20)]]) }, // 1 overlap
        );
        await saveProjectMetadata(
          projB,
          "/tmp/different-project",
          1,
          1,
          new Map([["x.ts", "h2"]]),
          "completed",
          {
            gitBlobShas: new Map([
              ["a.ts", "00".repeat(20)],
              ["b.ts", "11".repeat(20)],
            ]),
          },
        );

        try {
          const target = new Map([
            ["a.ts", "00".repeat(20)],
            ["b.ts", "11".repeat(20)],
          ]);
          const result = await findSiblingMetadata(fakePath, target, projA);
          // projA was excluded — projA2 has 1 overlap, projB excluded by projectPath
          expect(result).not.toBeNull();
          if (result == null) throw new Error("result was null");
          expect(result.collectionName).toBe(projA2);
          expect(result.matchCount).toBe(1);

          // Now query without exclusion: projA wins outright
          const without = await findSiblingMetadata(fakePath, target);
          expect(without).not.toBeNull();
          if (without == null) throw new Error("without was null");
          expect(without.collectionName).toBe(projA);
          expect(without.matchCount).toBe(2);
        } finally {
          const qdrant = getClient();
          for (const c of [projA, projA2, projB]) {
            await qdrant
              .delete(METADATA_COLLECTION, { points: [metadataPointId(c)] })
              .catch(() => {});
          }
        }
      },
      60_000,
    );
  });

  describe("collection deletion", () => {
    it("deletes the test collection", async () => {
      await deleteCollection(TEST_COLLECTION);

      const info = await getCollectionInfo(TEST_COLLECTION);
      expect(info).toBeNull();
    });

    it("does not error when deleting non-existent collection", async () => {
      await expect(
        deleteCollection("nonexistent_collection_xyz_test"),
      ).resolves.not.toThrow();
    });
  });
});
