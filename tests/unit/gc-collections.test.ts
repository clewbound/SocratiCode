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
});
