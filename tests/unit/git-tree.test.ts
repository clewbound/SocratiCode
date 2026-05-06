// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffGitTrees, getGitBlobShas } from "../../src/services/git-tree.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "git-tree-test-"));
  execSync("git init -q", { cwd: tmp });
  execSync("git config user.email test@test", { cwd: tmp });
  execSync("git config user.name test", { cwd: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("getGitBlobShas", () => {
  it("returns a map of tracked file paths to their git blob shas", async () => {
    writeFileSync(join(tmp, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(tmp, "b.ts"), "export const b = 2;\n");
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src/c.ts"), "export const c = 3;\n");
    execSync("git add . && git commit -qm initial", { cwd: tmp });

    const result = await getGitBlobShas(tmp);
    expect(result).not.toBeNull();
    if (result == null) throw new Error("expected non-null result");
    const map = result;
    expect(map.size).toBe(3);
    expect(map.get("a.ts")).toMatch(/^[0-9a-f]{40}$/);
    expect(map.get("b.ts")).toMatch(/^[0-9a-f]{40}$/);
    expect(map.get("src/c.ts")).toMatch(/^[0-9a-f]{40}$/);
    expect(map.get("a.ts")).not.toBe(map.get("b.ts"));
  });

  it("returns null on a non-git directory", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "non-git-"));
    try {
      const result = await getGitBlobShas(nonGit);
      expect(result).toBeNull();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("excludes untracked files", async () => {
    writeFileSync(join(tmp, "tracked.ts"), "x\n");
    execSync("git add tracked.ts && git commit -qm initial", { cwd: tmp });
    writeFileSync(join(tmp, "untracked.ts"), "y\n");
    const map = await getGitBlobShas(tmp);
    if (map == null) throw new Error("expected non-null result");
    expect(map.has("tracked.ts")).toBe(true);
    expect(map.has("untracked.ts")).toBe(false);
  });

  it("handles paths with spaces and unicode", async () => {
    writeFileSync(join(tmp, "with space.ts"), "x\n");
    writeFileSync(join(tmp, "café.ts"), "y\n");
    execSync("git add . && git commit -qm initial", { cwd: tmp });
    const map = await getGitBlobShas(tmp);
    if (map == null) throw new Error("expected non-null result");
    expect(map.has("with space.ts")).toBe(true);
    expect(map.has("café.ts")).toBe(true);
  });
});

describe("diffGitTrees", () => {
  it("classifies paths into unchanged/modified/added/deleted", () => {
    const prev = new Map([
      ["unchanged.ts", "aaa"],
      ["modified.ts", "bbb"],
      ["deleted.ts", "ccc"],
    ]);
    const curr = new Map([
      ["unchanged.ts", "aaa"],
      ["modified.ts", "bbb-new"],
      ["added.ts", "ddd"],
    ]);
    const diff = diffGitTrees(prev, curr);
    expect(diff).toEqual({
      unchanged: ["unchanged.ts"],
      modified: ["modified.ts"],
      added: ["added.ts"],
      deleted: ["deleted.ts"],
    });
  });

  it("returns all unchanged when maps are identical", () => {
    const m = new Map([
      ["a.ts", "111"],
      ["b.ts", "222"],
    ]);
    const diff = diffGitTrees(m, new Map(m));
    expect(diff).toEqual({
      unchanged: ["a.ts", "b.ts"],
      modified: [],
      added: [],
      deleted: [],
    });
  });

  it("treats empty prev as everything added", () => {
    const curr = new Map([["a.ts", "111"]]);
    const diff = diffGitTrees(new Map(), curr);
    expect(diff).toEqual({
      unchanged: [],
      modified: [],
      added: ["a.ts"],
      deleted: [],
    });
  });

  it("preserves insertion order from input Maps within each bucket", () => {
    // Multiple paths landing in the same bucket — locks the deterministic
    // ordering contract documented on diffGitTrees.
    const prev = new Map([
      ["z.ts", "z-old"],
      ["m.ts", "m-old"],
      ["a.ts", "a-old"],
      ["gone.ts", "gone-sha"],
    ]);
    const curr = new Map([
      ["z.ts", "z-new"], // modified, ordered first in curr
      ["m.ts", "m-old"], // unchanged, second
      ["a.ts", "a-new"], // modified, third
      ["new1.ts", "n1"], // added, fourth
      ["new2.ts", "n2"], // added, fifth
    ]);
    const diff = diffGitTrees(prev, curr);
    expect(diff.modified).toEqual(["z.ts", "a.ts"]);
    expect(diff.unchanged).toEqual(["m.ts"]);
    expect(diff.added).toEqual(["new1.ts", "new2.ts"]);
    expect(diff.deleted).toEqual(["gone.ts"]);
  });
});
