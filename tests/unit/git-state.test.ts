// SPDX-License-Identifier: AGPL-3.0-only
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTransientGitOperation } from "../../src/daemon/git-state.js";

let repo: string;
let common: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-state-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
  execSync("git commit -q --allow-empty -m initial", { cwd: repo });
  common = join(repo, ".git");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("hasTransientGitOperation", () => {
  it("returns false on a clean repo", () => {
    expect(hasTransientGitOperation(common)).toBe(false);
  });
  it("returns true when rebase-merge/ exists", () => {
    mkdirSync(join(common, "rebase-merge"));
    expect(hasTransientGitOperation(common)).toBe(true);
  });
  it("returns true when MERGE_HEAD exists", () => {
    writeFileSync(join(common, "MERGE_HEAD"), "abc\n");
    expect(hasTransientGitOperation(common)).toBe(true);
  });
  it("returns true when CHERRY_PICK_HEAD exists", () => {
    writeFileSync(join(common, "CHERRY_PICK_HEAD"), "abc\n");
    expect(hasTransientGitOperation(common)).toBe(true);
  });
  it("returns true when BISECT_LOG exists", () => {
    writeFileSync(join(common, "BISECT_LOG"), "");
    expect(hasTransientGitOperation(common)).toBe(true);
  });
});
