// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectIdFromPath } from "../../src/config.js";
import {
  invalidateGraphCache,
  rebuildGraph,
} from "../../src/services/code-graph.js";
import { updateChangedFilesSymbolGraph } from "../../src/services/symbol-graph-incremental.js";
import {
  loadFilePayload,
  loadSymbolGraphMeta,
} from "../../src/services/symbol-graph-store.js";
import {
  createFixtureProject,
  type FixtureProject,
  isDockerAvailable,
} from "../helpers/fixtures.js";
import { waitForQdrant } from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "symbol-graph-incremental",
  { timeout: 120_000 },
  () => {
    let fixture: FixtureProject;
    let projectId: string;

    beforeAll(async () => {
      await waitForQdrant();
      fixture = createFixtureProject("symbol-graph-incremental-test");
      projectId = projectIdFromPath(fixture.root);
      // Establish baseline meta + payloads from a real full rebuild.
      await rebuildGraph(fixture.root);
    }, 60_000);

    afterAll(() => {
      invalidateGraphCache(fixture.root);
      fixture.cleanup();
    });

    it("returns fullRebuildRequired=false when meta exists (no-op call)", async () => {
      const graph = await rebuildGraph(fixture.root);
      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [],
      );
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.filesChanged).toBe(0);
      expect(result.filesRemoved).toBe(0);
    });

    it("re-extracts and persists a changed file's payload", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/index.ts";

      // Mutate the file: add a new exported function.
      const abs = path.join(fixture.root, rel);
      const original = fs.readFileSync(abs, "utf-8");
      try {
        fs.writeFileSync(
          abs,
          `${original}\nexport function brandNewIncrementalSymbol(): number { return 42; }\n`,
          "utf-8",
        );

        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(false);
        expect(result.filesChanged).toBe(1);

        // The new symbol should appear in the persisted payload.
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).toBeTruthy();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        expect(names).toContain("brandNewIncrementalSymbol");
      } finally {
        fs.writeFileSync(abs, original, "utf-8");
      }
    });

    it("is a no-op when content hash is unchanged", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/index.ts";
      const before = await loadSymbolGraphMeta(projectId);
      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [rel],
        [],
      );
      // The diff path detects identical hash and skips writes.
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.symbolsDelta).toBe(0);
      expect(result.edgesDelta).toBe(0);
      const after = await loadSymbolGraphMeta(projectId);
      expect(after?.symbolCount).toBe(before?.symbolCount);
    });

    it("removes a deleted file's payload from the store", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/utils/helpers.ts";
      // Confirm baseline.
      const before = await loadFilePayload(projectId, rel);
      expect(before).toBeTruthy();

      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [rel],
      );
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.filesRemoved).toBe(1);

      const after = await loadFilePayload(projectId, rel);
      expect(after).toBeNull();
    });
  },
);
