// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectGitBranchFromHead } from "../../src/config.js";

describe("detectGitBranchFromHead", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scbtest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeMainRepo(branch: string): string {
    const gitDir = path.join(tmpRoot, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    return tmpRoot;
  }

  it("reads branch from main repo .git/HEAD", () => {
    const p = writeMainRepo("develop");
    expect(detectGitBranchFromHead(p)).toBe("develop");
  });

  it("reads a slash-separated branch name", () => {
    const p = writeMainRepo("dion/100299-stage-funnel-export-fix");
    expect(detectGitBranchFromHead(p)).toBe("dion/100299-stage-funnel-export-fix");
  });

  it("reads a branch with underscores and dots", () => {
    const p = writeMainRepo("feat/v1.2.3_fix");
    expect(detectGitBranchFromHead(p)).toBe("feat/v1.2.3_fix");
  });

  it("returns null for detached HEAD (raw SHA)", () => {
    const gitDir = path.join(tmpRoot, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(
      path.join(gitDir, "HEAD"),
      "abcdef0123456789abcdef0123456789abcdef01\n",
    );
    expect(detectGitBranchFromHead(tmpRoot)).toBeNull();
  });

  it("returns null for symbolic ref to a tag (refs/tags/*)", () => {
    const gitDir = path.join(tmpRoot, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/tags/v1.0\n");
    expect(detectGitBranchFromHead(tmpRoot)).toBeNull();
  });

  it("returns null for symbolic ref outside refs/heads", () => {
    const gitDir = path.join(tmpRoot, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/remotes/origin/main\n");
    expect(detectGitBranchFromHead(tmpRoot)).toBeNull();
  });

  it("follows .git pointer file with absolute gitdir (worktree layout)", () => {
    const realGitDir = path.join(tmpRoot, "real-git");
    fs.mkdirSync(realGitDir);
    fs.writeFileSync(path.join(realGitDir, "HEAD"), "ref: refs/heads/feat-x\n");
    const wtPath = path.join(tmpRoot, "wt");
    fs.mkdirSync(wtPath);
    fs.writeFileSync(path.join(wtPath, ".git"), `gitdir: ${realGitDir}\n`);
    expect(detectGitBranchFromHead(wtPath)).toBe("feat-x");
  });

  it("follows .git pointer file with relative gitdir", () => {
    const mainGit = path.join(tmpRoot, "main", ".git");
    const linkedWtDir = path.join(mainGit, "worktrees", "wt");
    fs.mkdirSync(linkedWtDir, { recursive: true });
    fs.writeFileSync(path.join(linkedWtDir, "HEAD"), "ref: refs/heads/branch\n");

    const wtPath = path.join(tmpRoot, "main", "wt");
    fs.mkdirSync(wtPath);
    fs.writeFileSync(path.join(wtPath, ".git"), "gitdir: ../.git/worktrees/wt\n");
    expect(detectGitBranchFromHead(wtPath)).toBe("branch");
  });

  it("returns null when .git is missing", () => {
    expect(detectGitBranchFromHead(tmpRoot)).toBeNull();
  });

  it("returns null for a malformed .git pointer file", () => {
    fs.writeFileSync(path.join(tmpRoot, ".git"), "garbage\n");
    expect(detectGitBranchFromHead(tmpRoot)).toBeNull();
  });

  it("returns null when HEAD file is missing inside .git/", () => {
    fs.mkdirSync(path.join(tmpRoot, ".git"));
    expect(detectGitBranchFromHead(tmpRoot)).toBeNull();
  });

  it("trims surrounding whitespace from the HEAD line", () => {
    const gitDir = path.join(tmpRoot, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "  ref: refs/heads/main  \n");
    expect(detectGitBranchFromHead(tmpRoot)).toBe("main");
  });
});
