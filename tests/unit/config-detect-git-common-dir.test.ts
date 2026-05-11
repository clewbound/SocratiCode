// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectGitCommonDir } from "../../src/config.js";

describe("detectGitCommonDir", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scgcd-")));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeMainRepo(name: string): { repo: string; gitDir: string } {
    const repo = path.join(tmpRoot, name);
    const gitDir = path.join(repo, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    return { repo, gitDir };
  }

  it("returns absolute .git path for a main repo (.git is a directory)", () => {
    const { repo, gitDir } = writeMainRepo("main-repo");
    expect(detectGitCommonDir(repo)).toBe(gitDir);
  });

  it("follows a linked-worktree .git pointer with relative commondir", () => {
    // Layout mirrors `git worktree add`:
    //   main/.git/                      (real common dir)
    //   main/.git/worktrees/wt-name/    (worktree gitdir; absolute pointer)
    //   wt/.git                         file: 'gitdir: <abs>'
    //   <abs>/commondir                 file: '../..'
    const { gitDir: mainGitDir } = writeMainRepo("main");
    const wtGitDir = path.join(mainGitDir, "worktrees", "wt-name");
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");

    const wt = path.join(tmpRoot, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGitDir}\n`);

    expect(detectGitCommonDir(wt)).toBe(mainGitDir);
  });

  it("accepts an absolute commondir entry", () => {
    const { gitDir: mainGitDir } = writeMainRepo("main");
    const wtGitDir = path.join(mainGitDir, "worktrees", "wt2");
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, "commondir"), `${mainGitDir}\n`);

    const wt = path.join(tmpRoot, "wt2");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGitDir}\n`);

    expect(detectGitCommonDir(wt)).toBe(mainGitDir);
  });

  // Submodules use `.git` as a pointer to a gitdir under the parent's
  // .git/modules/<sub>. That gitdir has no `commondir` file because the
  // submodule has its own objects/refs — its common dir IS its gitdir.
  it("treats a pointer .git with no commondir file as a self-contained gitdir", () => {
    const subGitDir = path.join(tmpRoot, "parent", ".git", "modules", "sub");
    fs.mkdirSync(subGitDir, { recursive: true });

    const sub = path.join(tmpRoot, "parent", "sub");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, ".git"), `gitdir: ${subGitDir}\n`);

    expect(detectGitCommonDir(sub)).toBe(subGitDir);
  });

  it("returns null when .git is missing entirely", () => {
    const notGit = path.join(tmpRoot, "not-a-repo");
    fs.mkdirSync(notGit);
    expect(detectGitCommonDir(notGit)).toBeNull();
  });

  it("returns null when .git is a pointer file without a gitdir: line", () => {
    const wt = path.join(tmpRoot, "wt-bad");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), "this is garbage\n");
    expect(detectGitCommonDir(wt)).toBeNull();
  });

  it("returns null when the gitdir pointer points to a non-existent path", () => {
    const wt = path.join(tmpRoot, "wt-dangling");
    fs.mkdirSync(wt);
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${tmpRoot}/does-not-exist\n`,
    );
    expect(detectGitCommonDir(wt)).toBeNull();
  });

  it("trims trailing whitespace and newlines in the pointer file", () => {
    const { gitDir: mainGitDir } = writeMainRepo("main");
    const wtGitDir = path.join(mainGitDir, "worktrees", "wt3");
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, "commondir"), "  ../..  \n");

    const wt = path.join(tmpRoot, "wt3");
    fs.mkdirSync(wt);
    // extra whitespace in the pointer file
    fs.writeFileSync(path.join(wt, ".git"), `gitdir:   ${wtGitDir}  \n\n`);

    expect(detectGitCommonDir(wt)).toBe(mainGitDir);
  });
});
