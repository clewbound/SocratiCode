// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLiveBranchesFromGitDir } from "../../src/daemon/gc.js";

describe("readLiveBranchesFromGitDir", () => {
  let tmpRoot: string;
  let commonDir: string;

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scrlb-")));
    commonDir = path.join(tmpRoot, ".git");
    fs.mkdirSync(path.join(commonDir, "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(commonDir, "refs", "remotes", "origin"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLooseRef(rel: string): void {
    const full = path.join(commonDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "0000000000000000000000000000000000000000\n");
  }

  it("returns an empty set when no refs exist", () => {
    expect(readLiveBranchesFromGitDir(commonDir).size).toBe(0);
  });

  it("reads top-level loose refs in refs/heads", () => {
    writeLooseRef("refs/heads/develop");
    writeLooseRef("refs/heads/main");
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("develop")).toBe(true);
    expect(out.has("main")).toBe(true);
  });

  // Real-world branches are often nested (e.g. `dion/100299-fix`). Each
  // segment is a directory under refs/heads. Matches what
  // `git for-each-ref --format=%(refname:short) refs/heads` returns.
  it("reads nested loose refs and applies sanitizeBranchName (slash → underscore)", () => {
    writeLooseRef("refs/heads/dion/100299-stage-funnel-export-fix");
    writeLooseRef("refs/heads/feat/v1.2.3");
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("dion_100299-stage-funnel-export-fix")).toBe(true);
    // dots also sanitize to underscores, then collapse
    expect(out.has("feat_v1_2_3")).toBe(true);
  });

  it("reads loose refs in refs/remotes/origin and strips origin/ prefix", () => {
    writeLooseRef("refs/remotes/origin/develop");
    writeLooseRef("refs/remotes/origin/dion/foo");
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("develop")).toBe(true);
    expect(out.has("dion_foo")).toBe(true);
  });

  // refs/remotes/origin/HEAD is a symref pointing at the default branch.
  // `git for-each-ref` omits it; our reader must omit it too so the live
  // set doesn't contain a phantom "HEAD" entry.
  it("skips the refs/remotes/origin/HEAD symref file", () => {
    fs.writeFileSync(
      path.join(commonDir, "refs", "remotes", "origin", "HEAD"),
      "ref: refs/remotes/origin/develop\n",
    );
    writeLooseRef("refs/remotes/origin/develop");
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("develop")).toBe(true);
    expect(out.has("HEAD")).toBe(false);
  });

  // macOS sprinkles .DS_Store files inside .git/refs/. They would otherwise
  // sanitize to `DS_Store` and end up in the live set as ghost entries.
  it("skips dotfiles in ref directories", () => {
    fs.writeFileSync(path.join(commonDir, "refs", "heads", ".DS_Store"), "x");
    writeLooseRef("refs/heads/develop");
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("develop")).toBe(true);
    expect(out.has("DS_Store")).toBe(false);
    expect(out.has(".DS_Store")).toBe(false);
  });

  it("parses packed-refs heads + origin entries and ignores header/peel lines", () => {
    const packed = [
      "# pack-refs with: peeled fully-peeled sorted",
      "489659745228ca95dfe7f05c154dcea1fe7b042f refs/heads/feature-a",
      "06a8752d2942d54b93c007e5fda5deff1cb59bce refs/heads/dion/long-branch",
      "3f6cb8a483666af60c832ef2bb896c66f962cf92 refs/remotes/origin/develop",
      "1111111111111111111111111111111111111111 refs/tags/v1.0.0",
      "^abc1234abc1234abc1234abc1234abc1234abc12",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(commonDir, "packed-refs"), packed);

    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("feature-a")).toBe(true);
    expect(out.has("dion_long-branch")).toBe(true);
    expect(out.has("develop")).toBe(true);
    // tags must not enter the live branch set
    expect(out.has("v1_0_0")).toBe(false);
    expect(out.has("v1.0.0")).toBe(false);
  });

  it("merges loose and packed refs into one set (loose-wins is irrelevant for our use)", () => {
    writeLooseRef("refs/heads/loose-only");
    fs.writeFileSync(
      path.join(commonDir, "packed-refs"),
      [
        "# pack-refs with: peeled fully-peeled sorted",
        "489659745228ca95dfe7f05c154dcea1fe7b042f refs/heads/packed-only",
        "489659745228ca95dfe7f05c154dcea1fe7b042f refs/heads/loose-only",
        "",
      ].join("\n"),
    );
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("loose-only")).toBe(true);
    expect(out.has("packed-only")).toBe(true);
  });

  it("returns an empty set when commonDir does not exist", () => {
    expect(readLiveBranchesFromGitDir("/no/such/path").size).toBe(0);
  });

  it("survives a malformed packed-refs file (skips bad lines)", () => {
    writeLooseRef("refs/heads/loose");
    fs.writeFileSync(
      path.join(commonDir, "packed-refs"),
      [
        "this line is garbage",
        "489659745228ca95dfe7f05c154dcea1fe7b042f refs/heads/good",
        "another bad line",
        "",
      ].join("\n"),
    );
    const out = readLiveBranchesFromGitDir(commonDir);
    expect(out.has("loose")).toBe(true);
    expect(out.has("good")).toBe(true);
  });
});
