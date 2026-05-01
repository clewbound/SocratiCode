// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectionName, projectIdFromPath } from "../../src/config.js";
import { ensureQdrantReady } from "../../src/services/docker.js";
import {
  getIndexableFiles,
  getIndexingInProgressProjects,
  getLastCompleted,
  indexProject,
  isIndexingInProgress,
  removeProjectIndex,
  updateProjectIndex,
} from "../../src/services/indexer.js";
import { ensureOllamaReady } from "../../src/services/ollama.js";
import { deleteCollection, getCollectionInfo, searchChunks } from "../../src/services/qdrant.js";
import {
  addFileToFixture,
  createFixtureProject,
  type FixtureProject,
  isDockerAvailable,
  removeFixtureFile,
} from "../helpers/fixtures.js";
import { cleanupTestCollections, waitForOllama, waitForQdrant } from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();

describe.skipIf(!dockerAvailable)("indexer service", () => {
  let fixture: FixtureProject;
  let collection: string;

  beforeAll(async () => {
    await ensureQdrantReady();
    await ensureOllamaReady();
    await waitForQdrant();
    await waitForOllama();

    fixture = createFixtureProject("indexer-test");
    const projectId = projectIdFromPath(fixture.root);
    collection = collectionName(projectId);
  });

  afterAll(async () => {
    // Clean up: remove index and temp directory
    try {
      await removeProjectIndex(fixture.root);
    } catch {
      // ignore
    }
    fixture.cleanup();
    await cleanupTestCollections(fixture.root);
  });

  describe("getIndexableFiles", () => {
    it("returns files with supported extensions", async () => {
      const files = await getIndexableFiles(fixture.root);

      expect(files.length).toBeGreaterThan(0);

      // Should include our fixture files
      const fileNames = files.map((f) => path.basename(f));
      expect(fileNames).toContain("index.ts");
      expect(fileNames).toContain("types.ts");
      expect(fileNames).toContain("helpers.ts");
      expect(fileNames).toContain("math.ts");
      expect(fileNames).toContain("data_processor.py");
      expect(fileNames).toContain("README.md");
    });

    it("respects .gitignore rules", async () => {
      const files = await getIndexableFiles(fixture.root);

      // .gitignore has "*.log" — no log files should appear
      for (const f of files) {
        expect(f).not.toMatch(/\.log$/);
      }
    });

    it("includes special files like README and package.json", async () => {
      const files = await getIndexableFiles(fixture.root);
      const fileNames = files.map((f) => path.basename(f));

      // README.md and package.json are special files that get indexed
      expect(fileNames).toContain("README.md");
      expect(fileNames).toContain("package.json");

      // Dotfiles are excluded by glob (dot: false)
      expect(fileNames).not.toContain(".gitignore");
    });

    it("excludes node_modules", async () => {
      const files = await getIndexableFiles(fixture.root);
      for (const f of files) {
        expect(f).not.toContain("node_modules");
      }
    });
  });

  describe("indexProject (full index)", () => {
    const progressMessages: string[] = [];

    it("indexes the fixture project with real embeddings", async () => {
      const result = await indexProject(fixture.root, (msg) => {
        progressMessages.push(msg);
      });

      expect(result.filesIndexed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);
    }, 180_000); // Allow up to 3 minutes for first-time embedding

    it("reports progress during indexing", () => {
      expect(progressMessages.length).toBeGreaterThan(0);
      // Should have messages about finding files and indexing
      expect(progressMessages.some((m) => m.includes("indexable files"))).toBe(true);
    });

    it("creates a Qdrant collection with indexed chunks", async () => {
      const info = await getCollectionInfo(collection);
      expect(info).toBeDefined();
      expect(info?.pointsCount).toBeGreaterThan(0);
    });

    it("tracks last completed indexing", () => {
      const completed = getLastCompleted(fixture.root);
      expect(completed).toBeDefined();
      expect(completed?.type).toBe("full-index");
      expect(completed?.filesProcessed).toBeGreaterThan(0);
      expect(completed?.chunksCreated).toBeGreaterThan(0);
      expect(completed?.durationMs).toBeGreaterThan(0);
      expect(completed?.error).toBeUndefined();
    });

    it("is no longer in progress after completion", () => {
      expect(isIndexingInProgress(fixture.root)).toBe(false);
    });

    it("no projects are in progress", () => {
      const inProgress = getIndexingInProgressProjects();
      expect(inProgress).not.toContain(path.resolve(fixture.root));
    });
  });

  describe("search after indexing", () => {
    it("finds authentication code via semantic search", async () => {
      const results = await searchChunks(
        collection,
        "user authentication with JWT token validation",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      // Should find the authenticateUser function from src/index.ts
      const authResult = results.find((r) => r.content.includes("authenticateUser"));
      expect(authResult).toBeDefined();
    });

    it("finds mathematical functions via semantic search", async () => {
      const results = await searchChunks(
        collection,
        "fibonacci sequence calculation",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      const mathResult = results.find((r) => r.content.includes("fibonacci"));
      expect(mathResult).toBeDefined();
    });

    it("finds Python code via semantic search", async () => {
      const results = await searchChunks(
        collection,
        "data processing JSON file loading",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      const pyResult = results.find((r) => r.language === "python");
      expect(pyResult).toBeDefined();
    });

    it("finds helper utilities via semantic search", async () => {
      const results = await searchChunks(
        collection,
        "string formatting title case conversion",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      const helperResult = results.find(
        (r) => r.content.includes("toTitleCase") || r.content.includes("greet"),
      );
      expect(helperResult).toBeDefined();
    });
  });

  describe("updateProjectIndex (incremental)", () => {
    it("detects no changes when nothing has changed", async () => {
      const result = await updateProjectIndex(fixture.root);

      // Nothing changed, so minimal or zero updates
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
    }, 120_000);

    it("detects a new file", async () => {
      // Add a new file to the fixture
      addFileToFixture(
        fixture.root,
        "src/newfeature.ts",
        `/**
 * A brand new feature for handling webhook events.
 * Processes incoming HTTP webhook payloads.
 */
export function handleWebhook(payload: unknown): { status: string } {
  if (!payload) return { status: "empty" };
  return { status: "processed" };
}
`,
      );

      const result = await updateProjectIndex(fixture.root, (_msg) => {
        // Just capture progress silently
      });

      expect(result.added).toBeGreaterThanOrEqual(1);
    }, 120_000);

    it("finds the newly added file in search results", async () => {
      const results = await searchChunks(
        collection,
        "webhook event handling HTTP payload processing",
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      const webhookResult = results.find((r) => r.content.includes("handleWebhook"));
      expect(webhookResult).toBeDefined();
    });

    it("detects removed files", async () => {
      removeFixtureFile(fixture.root, "src/newfeature.ts");

      const result = await updateProjectIndex(fixture.root);
      expect(result.removed).toBeGreaterThanOrEqual(1);
    }, 120_000);
  });

  describe("removeProjectIndex", () => {
    it("removes the entire index for the project", async () => {
      await removeProjectIndex(fixture.root);

      const info = await getCollectionInfo(collection);
      expect(info).toBeNull();
    });
  });
});

describe.skipIf(!dockerAvailable)("indexer service — embedding cache", () => {
  let cacheFixture: FixtureProject;
  const cacheCollName = "socraticode_embedding_cache";
  const populateProjectId = "indexer-cache-populate";
  const reuseProjectId = "indexer-cache-reuse";

  beforeAll(async () => {
    await ensureQdrantReady();
    await ensureOllamaReady();
    await waitForQdrant();
    await waitForOllama();

    cacheFixture = createFixtureProject("indexer-cache-test");
    process.env.SOCRATICODE_EMBEDDING_CACHE = "true";

    // Start with a clean cache collection so test assertions about growth are
    // deterministic.
    try {
      await deleteCollection(cacheCollName);
    } catch {
      // ignore — collection may not exist yet
    }
  });

  afterAll(async () => {
    delete process.env.SOCRATICODE_EMBEDDING_CACHE;

    // Clean up the sibling project collections we created.
    for (const projectId of [populateProjectId, reuseProjectId]) {
      process.env.SOCRATICODE_PROJECT_ID = projectId;
      try {
        await removeProjectIndex(cacheFixture.root);
      } catch {
        // ignore
      }
    }
    delete process.env.SOCRATICODE_PROJECT_ID;

    try {
      await deleteCollection(cacheCollName);
    } catch {
      // ignore
    }

    cacheFixture.cleanup();
  });

  it(
    "populates the shared cache on a fresh index",
    async () => {
      process.env.SOCRATICODE_PROJECT_ID = populateProjectId;
      const result = await indexProject(cacheFixture.root);
      expect(result.chunksCreated).toBeGreaterThan(0);

      const cacheInfo = await getCollectionInfo(cacheCollName);
      expect(cacheInfo).not.toBeNull();
      expect(cacheInfo?.pointsCount).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "reuses cached vectors when indexing a sibling collection on identical content",
    async () => {
      const cacheBefore = (await getCollectionInfo(cacheCollName))?.pointsCount ?? 0;
      expect(cacheBefore).toBeGreaterThan(0);

      // Same fixture content, different project ID → fresh per-collection
      // skip-by-hash state forces a re-index, but the shared cache should
      // catch every file.
      process.env.SOCRATICODE_PROJECT_ID = reuseProjectId;
      const messages: string[] = [];
      const result = await indexProject(cacheFixture.root, (m) => messages.push(m));
      expect(result.chunksCreated).toBeGreaterThan(0);

      // Cache point count must not grow — every file was a hit.
      const cacheAfter = (await getCollectionInfo(cacheCollName))?.pointsCount ?? 0;
      expect(cacheAfter).toBe(cacheBefore);

      // The indexer should advertise the cache hit in its progress messages.
      expect(
        messages.some((m) => m.includes("reused from shared cache")),
      ).toBe(true);
    },
    180_000,
  );
});

describe.skipIf(!dockerAvailable)("indexer service — same-collection fast-skip", () => {
  beforeAll(async () => {
    await ensureQdrantReady();
    await ensureOllamaReady();
    await waitForQdrant();
    await waitForOllama();
  });

  it(
    "skips scan + embed when re-indexing an unchanged branch (same-collection fast path)",
    async () => {
      const fixture = createFixtureProject("fast-skip-test");
      try {
        // Fast-path requires a git index — initialise the fixture as a git repo
        // and stage every file so getGitBlobShas can read blob shas.
        const gitOpts = {
          cwd: fixture.root,
          stdio: "ignore" as const,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fast Skip Test",
            GIT_AUTHOR_EMAIL: "fast-skip@example.com",
            GIT_COMMITTER_NAME: "Fast Skip Test",
            GIT_COMMITTER_EMAIL: "fast-skip@example.com",
          },
        };
        execSync("git init -q", gitOpts);
        execSync("git add -A", gitOpts);
        execSync("git commit -q -m initial", gitOpts);

        process.env.SOCRATICODE_PROJECT_ID = "fast-skip-populate";
        const first = await indexProject(fixture.root);
        expect(first.chunksCreated).toBeGreaterThan(0);

        // Second index on the SAME collection with no file changes
        const messages: string[] = [];
        const start = Date.now();
        const second = await indexProject(fixture.root, (m) => messages.push(m));
        const elapsedMs = Date.now() - start;

        // Fast-path took: explicit fast-path progress message must be present.
        expect(messages.some((m) => /fast.path/i.test(m))).toBe(true);

        // Fast-path skipped scan + embed: no "indexable files" scan message
        // and no "generating embeddings" message.
        expect(messages.some((m) => m.includes("indexable files"))).toBe(false);
        expect(messages.some((m) => m.includes("generating embeddings"))).toBe(false);

        expect(elapsedMs).toBeLessThan(30_000);
        expect(second.chunksCreated).toBe(0);
      } finally {
        try {
          await removeProjectIndex(fixture.root);
        } catch {
          // ignore
        }
        delete process.env.SOCRATICODE_PROJECT_ID;
        fixture.cleanup();
      }
    },
    300_000,
  );
});

describe.skipIf(!dockerAvailable)("indexer service — sibling-clone fast path", () => {
  beforeAll(async () => {
    await ensureQdrantReady();
    await ensureOllamaReady();
    await waitForQdrant();
    await waitForOllama();
  });

  // Initialise a fixture as a git repo and stage every file so getGitBlobShas
  // can produce blob shas. Mirrors the same-collection fast-skip test setup.
  function initGitFixture(fixture: FixtureProject): void {
    const gitOpts = {
      cwd: fixture.root,
      stdio: "ignore" as const,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Sibling Clone Test",
        GIT_AUTHOR_EMAIL: "sibling-clone@example.com",
        GIT_COMMITTER_NAME: "Sibling Clone Test",
        GIT_COMMITTER_EMAIL: "sibling-clone@example.com",
      },
    };
    execSync("git init -q", gitOpts);
    execSync("git add -A", gitOpts);
    execSync("git commit -q -m initial", gitOpts);
  }

  function commitFileChange(fixture: FixtureProject, relativePath: string, newContent: string): void {
    const fullPath = path.join(fixture.root, relativePath);
    writeFileSync(fullPath, newContent);
    const gitOpts = {
      cwd: fixture.root,
      stdio: "ignore" as const,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Sibling Clone Test",
        GIT_AUTHOR_EMAIL: "sibling-clone@example.com",
        GIT_COMMITTER_NAME: "Sibling Clone Test",
        GIT_COMMITTER_EMAIL: "sibling-clone@example.com",
      },
    };
    execSync(`git add ${relativePath}`, gitOpts);
    execSync(`git commit -q -m "modify ${relativePath}"`, gitOpts);
  }

  it(
    "indexes a fresh collection in seconds when content matches sibling",
    async () => {
      const fixture = createFixtureProject("clone-no-diff");
      try {
        initGitFixture(fixture);

        process.env.SOCRATICODE_PROJECT_ID = "clone-test-source";
        const first = await indexProject(fixture.root);
        expect(first.chunksCreated).toBeGreaterThan(0);

        // Re-index under a different project ID with the same content.
        process.env.SOCRATICODE_PROJECT_ID = "clone-test-target";
        const messages: string[] = [];
        const start = Date.now();
        const result = await indexProject(fixture.root, (m) => messages.push(m));
        const elapsedMs = Date.now() - start;

        expect(messages.some((m) => /sibling.clone|cloned.*\d+ points|fast.path/i.test(m))).toBe(true);
        expect(elapsedMs).toBeLessThan(60_000);
        expect(result.chunksCreated).toBe(0);
      } finally {
        for (const projectId of ["clone-test-source", "clone-test-target"]) {
          process.env.SOCRATICODE_PROJECT_ID = projectId;
          try {
            await removeProjectIndex(fixture.root);
          } catch {
            // ignore
          }
        }
        delete process.env.SOCRATICODE_PROJECT_ID;
        fixture.cleanup();
      }
    },
    300_000,
  );

  it(
    "scans only the diff when a file is modified",
    async () => {
      const fixture = createFixtureProject("clone-with-diff");
      try {
        initGitFixture(fixture);

        process.env.SOCRATICODE_PROJECT_ID = "clone-diff-source";
        const first = await indexProject(fixture.root);
        const baselineChunks = first.chunksCreated;
        expect(baselineChunks).toBeGreaterThan(0);

        // Modify a single file already created by the fixture.
        commitFileChange(
          fixture,
          "src/utils/math.ts",
          `// changed
export function add(a: number, b: number): number {
  return a + b + 0;
}

export function fibonacci(n: number): number {
  // Brand new fibonacci with detailed tail-call discussion to ensure new
  // chunks are produced even on a small file.
  if (n < 2) return n;
  let prev = 0;
  let curr = 1;
  for (let i = 2; i <= n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return curr;
}
`,
        );

        process.env.SOCRATICODE_PROJECT_ID = "clone-diff-target";
        const messages: string[] = [];
        const start = Date.now();
        const result = await indexProject(fixture.root, (m) => messages.push(m));
        const elapsedMs = Date.now() - start;

        expect(messages.some((m) => /sibling.clone/i.test(m))).toBe(true);
        expect(result.chunksCreated).toBeGreaterThan(0);
        expect(result.chunksCreated).toBeLessThan(baselineChunks);
        expect(elapsedMs).toBeLessThan(120_000);
      } finally {
        for (const projectId of ["clone-diff-source", "clone-diff-target"]) {
          process.env.SOCRATICODE_PROJECT_ID = projectId;
          try {
            await removeProjectIndex(fixture.root);
          } catch {
            // ignore
          }
        }
        delete process.env.SOCRATICODE_PROJECT_ID;
        fixture.cleanup();
      }
    },
    300_000,
  );

  it(
    "falls through to full index when no sibling exists",
    async () => {
      const fixture = createFixtureProject("clone-no-sibling");
      try {
        initGitFixture(fixture);

        process.env.SOCRATICODE_PROJECT_ID = `clone-fresh-${Date.now()}`;
        const messages: string[] = [];
        const result = await indexProject(fixture.root, (m) => messages.push(m));
        expect(messages.some((m) => /sibling.clone/i.test(m))).toBe(false);
        expect(result.chunksCreated).toBeGreaterThan(0);
      } finally {
        try {
          await removeProjectIndex(fixture.root);
        } catch {
          // ignore
        }
        delete process.env.SOCRATICODE_PROJECT_ID;
        fixture.cleanup();
      }
    },
    300_000,
  );
});
