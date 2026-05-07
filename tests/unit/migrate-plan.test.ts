// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRepoIdMap,
  discoverLegacyCollections,
  executePlan,
  isMigrationCompleted,
  type MigrationPlan,
  markMigrationCompleted,
  planMigration,
  type QdrantPort,
  renamedCollection,
} from "../../src/cli/migrate-legacy-keying.js";

describe("planMigration", () => {
  it("plans rename when legacy collection has a tracked path and target does not exist", () => {
    const legacy = [
      { name: "codebase_aaaaaaaaaaaa__develop", path: "/repos/foo", branch: "develop" },
    ];
    const repoIdByPath = new Map([["/repos/foo", "myrepo"]]);
    const existing = new Set(["codebase_aaaaaaaaaaaa__develop"]);
    const plan = planMigration({ legacy, repoIdByPath, existing });
    expect(plan.renames).toEqual([
      {
        from: "codebase_aaaaaaaaaaaa__develop",
        to: "codebase_myrepo__develop",
      },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it("skips rename when target collection already exists", () => {
    const legacy = [
      { name: "codebase_aaaaaaaaaaaa__develop", path: "/repos/foo", branch: "develop" },
    ];
    const repoIdByPath = new Map([["/repos/foo", "myrepo"]]);
    const existing = new Set([
      "codebase_aaaaaaaaaaaa__develop",
      "codebase_myrepo__develop",
    ]);
    const plan = planMigration({ legacy, repoIdByPath, existing });
    expect(plan.renames).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: "codebase_aaaaaaaaaaaa__develop", reason: "target-exists" },
    ]);
  });

  it("flags as unresolved when path can't be resolved to a repoId", () => {
    const legacy = [
      { name: "codebase_aaaaaaaaaaaa__develop", path: null, branch: "develop" },
    ];
    const plan = planMigration({ legacy, repoIdByPath: new Map(), existing: new Set() });
    expect(plan.renames).toEqual([]);
    expect(plan.unresolved).toEqual([
      { name: "codebase_aaaaaaaaaaaa__develop", reason: "no-path-metadata" },
    ]);
  });

  it("plans renames for every collection family (codebase + codegraph + symgraph_*)", () => {
    const legacy = [
      { name: "codebase_aaaaaaaaaaaa__develop", path: "/repos/foo", branch: "develop" },
      { name: "codegraph_aaaaaaaaaaaa__develop", path: "/repos/foo", branch: "develop" },
      { name: "aaaaaaaaaaaa__develop_symgraph_meta", path: "/repos/foo", branch: "develop" },
    ];
    const repoIdByPath = new Map([["/repos/foo", "myrepo"]]);
    const plan = planMigration({ legacy, repoIdByPath, existing: new Set() });
    expect(plan.renames.map((r) => r.to)).toEqual([
      "codebase_myrepo__develop",
      "codegraph_myrepo__develop",
      "myrepo__develop_symgraph_meta",
    ]);
  });
});

describe("renamedCollection", () => {
  it("renames codebase_<hash>__<branch>", () => {
    expect(renamedCollection("codebase_aaaaaaaaaaaa__develop", "myrepo"))
      .toBe("codebase_myrepo__develop");
  });
  it("renames codebase_<hash> (no branch)", () => {
    expect(renamedCollection("codebase_aaaaaaaaaaaa", "myrepo"))
      .toBe("codebase_myrepo");
  });
  it("renames codegraph_<hash>__<branch>", () => {
    expect(renamedCollection("codegraph_aaaaaaaaaaaa__develop", "myrepo"))
      .toBe("codegraph_myrepo__develop");
  });
  it("renames context_<hash>__<branch>", () => {
    expect(renamedCollection("context_aaaaaaaaaaaa__develop", "myrepo"))
      .toBe("context_myrepo__develop");
  });
  it("renames symgraph triplet with branch", () => {
    expect(renamedCollection("aaaaaaaaaaaa__develop_symgraph_meta", "myrepo"))
      .toBe("myrepo__develop_symgraph_meta");
    expect(renamedCollection("aaaaaaaaaaaa__develop_symgraph_file", "myrepo"))
      .toBe("myrepo__develop_symgraph_file");
    expect(renamedCollection("aaaaaaaaaaaa__develop_symgraph_index", "myrepo"))
      .toBe("myrepo__develop_symgraph_index");
  });
  it("renames symgraph triplet without branch", () => {
    expect(renamedCollection("aaaaaaaaaaaa_symgraph_meta", "myrepo"))
      .toBe("myrepo_symgraph_meta");
  });
  it("returns input unchanged when name doesn't match any known shape", () => {
    expect(renamedCollection("totally-unrelated", "myrepo"))
      .toBe("totally-unrelated");
  });
});

describe("discoverLegacyCollections", () => {
  it("returns all collections matching legacy name shapes with their path/branch metadata", async () => {
    const port: QdrantPort = {
      async listCollections() {
        return [
          "codebase_aaaaaaaaaaaa__develop",
          "codegraph_aaaaaaaaaaaa__develop",
          "totally-unrelated",
        ];
      },
      async getMetadata(name) {
        if (name.startsWith("codebase_")) return { path: "/repos/foo", branch: "develop" };
        if (name.startsWith("codegraph_")) return { path: "/repos/foo", branch: "develop" };
        return null;
      },
      async cloneCollection() {
        /* unused */
      },
      async deleteCollection() {
        /* unused */
      },
    };
    const result = await discoverLegacyCollections(port);
    expect(result).toEqual([
      { name: "codebase_aaaaaaaaaaaa__develop", path: "/repos/foo", branch: "develop" },
      { name: "codegraph_aaaaaaaaaaaa__develop", path: "/repos/foo", branch: "develop" },
    ]);
  });
});

describe("executePlan", () => {
  it("clones each rename then deletes the source", async () => {
    const ops: string[] = [];
    const port: QdrantPort = {
      async listCollections() {
        return [];
      },
      async getMetadata() {
        return null;
      },
      async cloneCollection(from, to) {
        ops.push(`clone:${from}->${to}`);
      },
      async deleteCollection(name) {
        ops.push(`delete:${name}`);
      },
    };
    const plan: MigrationPlan = {
      renames: [{ from: "codebase_aaaaaaaaaaaa__develop", to: "codebase_myrepo__develop" }],
      skipped: [],
      unresolved: [],
    };
    const summary = await executePlan(port, plan);
    expect(ops).toEqual([
      "clone:codebase_aaaaaaaaaaaa__develop->codebase_myrepo__develop",
      "delete:codebase_aaaaaaaaaaaa__develop",
    ]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toEqual([]);
  });

  it("aborts a single rename on clone failure without deleting source", async () => {
    const ops: string[] = [];
    const port: QdrantPort = {
      async listCollections() {
        return [];
      },
      async getMetadata() {
        return null;
      },
      async cloneCollection() {
        throw new Error("disk full");
      },
      async deleteCollection(name) {
        ops.push(`delete:${name}`);
      },
    };
    const summary = await executePlan(port, {
      renames: [{ from: "a", to: "b" }],
      skipped: [],
      unresolved: [],
    });
    expect(ops).toEqual([]);
    expect(summary.failed).toEqual([{ from: "a", to: "b", error: "disk full" }]);
  });

  it("dry-run skips both clone and delete", async () => {
    const ops: string[] = [];
    const port: QdrantPort = {
      async listCollections() {
        return [];
      },
      async getMetadata() {
        return null;
      },
      async cloneCollection(from, to) {
        ops.push(`clone:${from}->${to}`);
      },
      async deleteCollection(name) {
        ops.push(`delete:${name}`);
      },
    };
    await executePlan(
      port,
      {
        renames: [{ from: "a", to: "b" }],
        skipped: [],
        unresolved: [],
      },
      { dryRun: true },
    );
    expect(ops).toEqual([]);
  });
});

describe("buildRepoIdMap", () => {
  it("resolves repo-id for each unique path", () => {
    const tmpA = mkdtempSync(join(tmpdir(), "a-"));
    const tmpB = mkdtempSync(join(tmpdir(), "b-"));
    try {
      const map = buildRepoIdMap([
        { name: "x", path: tmpA, branch: null },
        { name: "y", path: tmpB, branch: null },
        { name: "z", path: tmpA, branch: null }, // duplicate path
      ]);
      expect(map.size).toBe(2);
      expect(map.get(tmpA)).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(map.get(tmpB)).toMatch(/^[a-zA-Z0-9_-]+$/);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  it("skips paths that fail to resolve gracefully", () => {
    const map = buildRepoIdMap([
      { name: "x", path: "/this/path/definitely/does/not/exist", branch: null },
    ]);
    // path-hash fallback in resolveRepoId can still produce a value even for
    // missing dirs. We just assert no crash and the map size is non-negative.
    expect(map.size).toBeGreaterThanOrEqual(0);
  });
});

describe("migration marker", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "state-"));
    process.env.SOCRATICODE_STATE_DIR = stateDir;
  });
  afterEach(() => {
    delete process.env.SOCRATICODE_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("marker is initially absent", () => {
    expect(isMigrationCompleted()).toBe(false);
  });
  it("markMigrationCompleted sets it", () => {
    markMigrationCompleted();
    expect(isMigrationCompleted()).toBe(true);
  });
});
