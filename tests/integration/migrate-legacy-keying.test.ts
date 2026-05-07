// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigration } from "../../src/cli/migrate-legacy-keying.js";
import { getClient } from "../../src/services/qdrant.js";

const SHOULD_RUN = process.env.SOCRATICODE_INTEGRATION === "true";

describe.skipIf(!SHOULD_RUN)("migrate-legacy-keying integration", () => {
  const LEGACY = "codebase_aaaaaaaaaaaa__test-migrate";
  const NEW = "codebase_e2e-test__test-migrate"; // SOCRATICODE_REPO_ID below pins repoId to "e2e-test"

  beforeAll(async () => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    process.env.SOCRATICODE_REPO_ID = "e2e-test";
    const qdrant = getClient();
    // Create a legacy collection with metadata
    await qdrant.createCollection(LEGACY, { vectors: { size: 4, distance: "Cosine" } });
    await qdrant.upsert(LEGACY, {
      points: [
        {
          id: 0,
          vector: [0.1, 0.2, 0.3, 0.4],
          payload: { __metadata: true, projectPath: "/tmp/some-fake", branch: "test-migrate" },
        },
      ],
    });
  });

  afterAll(async () => {
    delete process.env.SOCRATICODE_REPO_KEYING;
    delete process.env.SOCRATICODE_REPO_ID;
    const qdrant = getClient();
    for (const name of [LEGACY, NEW]) {
      try {
        await qdrant.deleteCollection(name);
      } catch {
        /* noop */
      }
    }
  });

  it("renames the legacy collection to the new repo-keyed name", async () => {
    const { plan, summary } = await runMigration({ dryRun: false });
    expect(plan.renames.some((r) => r.from === LEGACY && r.to === NEW)).toBe(true);
    expect(summary.failed).toEqual([]);

    const qdrant = getClient();
    const { collections } = await qdrant.getCollections();
    const names = collections.map((c) => c.name);
    expect(names).toContain(NEW);
    expect(names).not.toContain(LEGACY);
  });
});
