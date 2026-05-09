// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { describe, expect, it } from "vitest";
import { parseCollectionName } from "../../src/daemon/gc.js";

describe("parseCollectionName", () => {
  it("parses codebase_<repoId>__<branch>", () => {
    expect(parseCollectionName("codebase_myrepo__develop")).toMatchObject({
      prefix: "codebase_",
      repoId: "myrepo",
      branch: "develop",
      detached: false,
    });
  });

  it("parses codegraph_<repoId>__<branch>", () => {
    expect(parseCollectionName("codegraph_myrepo__feature-x")).toMatchObject({
      prefix: "codegraph_",
      repoId: "myrepo",
      branch: "feature-x",
      detached: false,
    });
  });

  it("parses context_<repoId>__<branch>", () => {
    expect(parseCollectionName("context_myrepo__main")).toMatchObject({
      prefix: "context_",
      repoId: "myrepo",
      branch: "main",
      detached: false,
    });
  });

  it("identifies detached collections", () => {
    expect(parseCollectionName("codebase_myrepo__detached_abc12345")).toMatchObject({
      detached: true,
    });
  });

  it("returns truthy for non-prefixed loose names (filtered downstream by repoId)", () => {
    // The parser is intentionally permissive — the live-set check via repoId
    // is what prevents accidental deletes of unrelated collections.
    expect(parseCollectionName("foo_bar_baz")).toBeTruthy();
  });

  it("returns null on empty input", () => {
    expect(parseCollectionName("")).toBeNull();
  });

  // Symgraph collections are named <repoId>__<branch>_symgraph_<kind>. The branch
  // capture group must not eat the trailing "_symgraph_*" suffix, otherwise the
  // live-set lookup compares against "develop_symgraph_file" instead of "develop"
  // and live collections are flagged dead.
  it("parses <repoId>__<branch>_symgraph_<kind> with branch captured separately", () => {
    expect(parseCollectionName("dd84eca85090__develop_symgraph_file")).toMatchObject({
      prefix: "",
      repoId: "dd84eca85090",
      branch: "develop",
      detached: false,
    });
  });

  it("parses <repoId>__<branch>_symgraph_meta", () => {
    expect(parseCollectionName("dd84eca85090__develop_symgraph_meta")).toMatchObject({
      repoId: "dd84eca85090",
      branch: "develop",
    });
  });

  it("parses <repoId>__<branch>_symgraph_index", () => {
    expect(parseCollectionName("dd84eca85090__develop_symgraph_index")).toMatchObject({
      repoId: "dd84eca85090",
      branch: "develop",
    });
  });

  it("parses branch with underscores plus _symgraph_<kind>", () => {
    expect(parseCollectionName("xx__feature_branch_symgraph_meta")?.branch).toBe(
      "feature_branch",
    );
  });

  it("still parses bare branch with underscores (no symgraph suffix)", () => {
    expect(parseCollectionName("dd84eca85090__develop_branch")?.branch).toBe(
      "develop_branch",
    );
  });

  it("still parses detached HEAD branch suffix", () => {
    expect(parseCollectionName("dd84eca85090__detached_abc12345")).toMatchObject({
      branch: "detached_abc12345",
      detached: true,
    });
  });
});
