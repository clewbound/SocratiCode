// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Unit tests for the ensureOllamaReady conditional guard in query-tools.ts.
 * Verifies that codebase_search only calls ensureOllamaReady() for the Ollama
 * provider, and uses getEmbeddingProvider() for OpenAI/Google.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── embedding-config.js mock ─────────────────────────────────────────────

const mockGetEmbeddingConfig = vi.fn(() => ({
  embeddingProvider: "ollama" as string,
  embeddingModel: "test-model",
}));

vi.mock("../../src/services/embedding-config.js", () => ({
  getEmbeddingConfig: (...args: unknown[]) => mockGetEmbeddingConfig(...(args as [])),
}));

// ── embedding-provider.js mock ───────────────────────────────────────────

const mockGetEmbeddingProvider = vi.fn(async () => ({
  embed: vi.fn(),
  ensureReady: vi.fn(async () => ({ imagePulled: false, containerStarted: false, modelPulled: false })),
  health: vi.fn(),
}));

vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: (...args: unknown[]) => mockGetEmbeddingProvider(...(args as [])),
}));

// ── ollama.js mock ───────────────────────────────────────────────────────

const mockEnsureOllamaReady = vi.fn(async () => ({
  modelPulled: false,
  containerStarted: false,
  imagePulled: false,
}));

vi.mock("../../src/services/ollama.js", () => ({
  ensureOllamaReady: (...args: unknown[]) => mockEnsureOllamaReady(...(args as [])),
}));

// ── docker.js mock ───────────────────────────────────────────────────────

vi.mock("../../src/services/docker.js", () => ({
  ensureQdrantReady: vi.fn(async () => ({ pulled: false, started: false })),
  isDockerAvailable: vi.fn(async () => true),
}));

// ── qdrant.js mock ───────────────────────────────────────────────────────

const mockSearchChunks = vi.fn(async (_collection: string, _query: string, _limit: number) => []);

vi.mock("../../src/services/qdrant.js", () => ({
  searchChunks: (...args: unknown[]) => mockSearchChunks(...(args as [string, string, number])),
  getCollectionInfo: vi.fn(async () => ({ points_count: 0 })),
  getProjectMetadata: vi.fn(async () => null),
}));

// ── config.js mock ───────────────────────────────────────────────────────

vi.mock("../../src/config.js", () => ({
  collectionName: vi.fn(() => "test-collection"),
  projectIdFromPath: vi.fn(() => "test-project-id"),
}));

// ── indexer.js mock ──────────────────────────────────────────────────────

vi.mock("../../src/services/indexer.js", () => ({
  isIndexingInProgress: vi.fn(() => false),
  getIndexingProgress: vi.fn(() => null),
  getLastCompleted: vi.fn(() => null),
}));

// ── code-graph.js mock ──────────────────────────────────────────────────

vi.mock("../../src/services/code-graph.js", () => ({
  getGraphStatus: vi.fn(async () => null),
}));

// ── context-artifacts.js mock ───────────────────────────────────────────

vi.mock("../../src/services/context-artifacts.js", () => ({
  getArtifactStatusSummary: vi.fn(async () => null),
}));

// ── watcher.js mock ──────────────────────────────────────────────────────

vi.mock("../../src/services/watcher.js", () => ({
  ensureWatcherStarted: vi.fn(),
  isWatching: vi.fn(() => false),
  isWatchedByAnyProcess: vi.fn(async () => false),
}));

// ── lock.js mock ─────────────────────────────────────────────────────────

vi.mock("../../src/services/lock.js", () => ({
  getLockHolderPid: vi.fn(async () => null),
}));

// ── constants.js mock ────────────────────────────────────────────────────

vi.mock("../../src/constants.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original };
});

// ── Imports (after mocks) ────────────────────────────────────────────────

import { handleQueryTool } from "../../src/tools/query-tools.js";

// ── Tests ────────────────────────────────────────────────────────────────

const TEST_PATH = "/tmp/test-project";

describe("codebase_search — embedding provider readiness guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls ensureOllamaReady when embeddingProvider is ollama", async () => {
    mockGetEmbeddingConfig.mockReturnValue({
      embeddingProvider: "ollama",
      embeddingModel: "test-model",
    });

    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "test query",
    });

    expect(mockEnsureOllamaReady).toHaveBeenCalledOnce();
    expect(mockGetEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("calls getEmbeddingProvider (not ensureOllamaReady) when embeddingProvider is openai", async () => {
    mockGetEmbeddingConfig.mockReturnValue({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
    });

    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "test query",
    });

    expect(mockEnsureOllamaReady).not.toHaveBeenCalled();
    expect(mockGetEmbeddingProvider).toHaveBeenCalledOnce();
  });

  it("calls getEmbeddingProvider (not ensureOllamaReady) when embeddingProvider is google", async () => {
    mockGetEmbeddingConfig.mockReturnValue({
      embeddingProvider: "google",
      embeddingModel: "gemini-embedding-001",
    });

    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "test query",
    });

    expect(mockEnsureOllamaReady).not.toHaveBeenCalled();
    expect(mockGetEmbeddingProvider).toHaveBeenCalledOnce();
  });
});
