// tests/unit/config-repo-keying.test.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coreProjectId,
  gitCommonDirHash,
  isRepoKeyingActive,
  loadRepoIdFromConfig,
  projectIdFromPath,
  resolveLinkedCollections,
  resolveRepoId,
} from "../../src/config.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "config-repo-keying-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadRepoIdFromConfig", () => {
  it("reads repoId from .socraticode.json when present", () => {
    writeFileSync(join(tmp, ".socraticode.json"), JSON.stringify({ repoId: "ashby" }));
    expect(loadRepoIdFromConfig(tmp)).toBe("ashby");
  });

  it("returns null when .socraticode.json does not exist", () => {
    expect(loadRepoIdFromConfig(tmp)).toBeNull();
  });

  it("returns null when repoId field is missing", () => {
    writeFileSync(join(tmp, ".socraticode.json"), JSON.stringify({ linkedProjects: [] }));
    expect(loadRepoIdFromConfig(tmp)).toBeNull();
  });

  it("returns null when repoId is not a string", () => {
    writeFileSync(join(tmp, ".socraticode.json"), JSON.stringify({ repoId: 42 }));
    expect(loadRepoIdFromConfig(tmp)).toBeNull();
  });

  it("rejects repoId with invalid characters", () => {
    writeFileSync(join(tmp, ".socraticode.json"), JSON.stringify({ repoId: "bad/id" }));
    expect(() => loadRepoIdFromConfig(tmp)).toThrow(/must match/);
  });

  it("returns null on malformed JSON without throwing", () => {
    writeFileSync(join(tmp, ".socraticode.json"), "not json {");
    expect(loadRepoIdFromConfig(tmp)).toBeNull();
  });
});

describe("gitCommonDirHash", () => {
  it("returns a 12-hex hash for the main repo", () => {
    execSync("git init -q", { cwd: tmp });
    const hash = gitCommonDirHash(tmp);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns the same hash for a linked worktree as for its main repo", () => {
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
    execSync('git commit -q --allow-empty -m initial', { cwd: tmp });
    execSync('git checkout -q -b other', { cwd: tmp });
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    execSync('git checkout -q -', { cwd: tmp });
    execSync(`git worktree add -q ${wt} other`, { cwd: tmp });
    try {
      const main = gitCommonDirHash(tmp);
      const linked = gitCommonDirHash(wt);
      expect(linked).toBe(main);
    } finally {
      execSync(`git worktree remove ${wt}`, { cwd: tmp });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("returns null on a non-git directory", () => {
    expect(gitCommonDirHash(tmp)).toBeNull();
  });
});

describe("resolveRepoId", () => {
  beforeEach(() => {
    delete process.env.SOCRATICODE_REPO_ID;
  });

  it("uses SOCRATICODE_REPO_ID env when set", () => {
    process.env.SOCRATICODE_REPO_ID = "explicit-id";
    expect(resolveRepoId(tmp)).toBe("explicit-id");
  });

  it("validates SOCRATICODE_REPO_ID format", () => {
    process.env.SOCRATICODE_REPO_ID = "bad/id";
    expect(() => resolveRepoId(tmp)).toThrow(/must match/);
  });

  it("falls back to .socraticode.json repoId when env unset", () => {
    writeFileSync(join(tmp, ".socraticode.json"), JSON.stringify({ repoId: "from-json" }));
    expect(resolveRepoId(tmp)).toBe("from-json");
  });

  it("falls back to gitCommonDirHash when env+json unset and dir is git", () => {
    execSync("git init -q", { cwd: tmp });
    expect(resolveRepoId(tmp)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("falls back to path hash on non-git directories", () => {
    expect(resolveRepoId(tmp)).toMatch(/^[0-9a-f]{12}$/);
    // Should equal coreProjectId(tmp) since both hash the resolved path
    expect(resolveRepoId(tmp)).toBe(coreProjectId(tmp));
  });
});

describe("isRepoKeyingActive", () => {
  beforeEach(() => {
    delete process.env.SOCRATICODE_REPO_KEYING;
    delete process.env.SOCRATICODE_DAEMON_MODE;
  });

  it("returns true when SOCRATICODE_REPO_KEYING=true", () => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    expect(isRepoKeyingActive()).toBe(true);
  });

  it("returns true when SOCRATICODE_DAEMON_MODE=true (daemon implies repo-keying)", () => {
    process.env.SOCRATICODE_DAEMON_MODE = "true";
    expect(isRepoKeyingActive()).toBe(true);
  });

  it("returns false when neither is set", () => {
    expect(isRepoKeyingActive()).toBe(false);
  });

  it("returns false for SOCRATICODE_REPO_KEYING values other than 'true'", () => {
    process.env.SOCRATICODE_REPO_KEYING = "1";
    expect(isRepoKeyingActive()).toBe(false);
    process.env.SOCRATICODE_REPO_KEYING = "yes";
    expect(isRepoKeyingActive()).toBe(false);
  });
});

describe("projectIdFromPath under repo-keying", () => {
  beforeEach(() => {
    delete process.env.SOCRATICODE_REPO_KEYING;
    delete process.env.SOCRATICODE_DAEMON_MODE;
    delete process.env.SOCRATICODE_REPO_ID;
    delete process.env.SOCRATICODE_BRANCH_AWARE;
    delete process.env.SOCRATICODE_PROJECT_ID;
  });

  it("with repo-keying off, behavior is unchanged from coreProjectId", () => {
    expect(projectIdFromPath(tmp)).toBe(coreProjectId(tmp));
  });

  it("with repo-keying on and a branch, returns <repoId>__<branch>", () => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
    execSync("git commit -q --allow-empty -m initial && git branch -M develop", { cwd: tmp });
    const id = projectIdFromPath(tmp);
    expect(id).toMatch(/^[0-9a-f]{12}__develop$/);
  });

  it("with repo-keying on and detached HEAD, returns __detached_<short-sha>", () => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
    execSync("git commit -q --allow-empty -m initial", { cwd: tmp });
    const sha = execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf-8" }).trim();
    execSync(`git checkout -q ${sha}`, { cwd: tmp });
    const id = projectIdFromPath(tmp);
    expect(id).toMatch(new RegExp(`^[0-9a-f]{12}__detached_${sha.slice(0, 8)}$`));
  });

  it("SOCRATICODE_PROJECT_ID always wins (overrides repo-keying)", () => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    process.env.SOCRATICODE_PROJECT_ID = "my-id";
    expect(projectIdFromPath(tmp)).toBe("my-id");
  });

  it("BRANCH_AWARE alone (without REPO_KEYING) keeps legacy behavior", () => {
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
    execSync("git commit -q --allow-empty -m initial && git branch -M legacy-branch", { cwd: tmp });
    const id = projectIdFromPath(tmp);
    // legacy: <pathhash>__<branch>
    expect(id).toBe(`${coreProjectId(tmp)}__legacy-branch`);
  });
});

describe("backward compatibility", () => {
  beforeEach(() => {
    delete process.env.SOCRATICODE_REPO_KEYING;
    delete process.env.SOCRATICODE_DAEMON_MODE;
  });

  it("path-only id is unchanged when no flags set", () => {
    const before = projectIdFromPath(tmp);
    expect(before).toBe(coreProjectId(tmp));
  });

  it("BRANCH_AWARE produces identical id with or without repo-keying disabled", () => {
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
    execSync("git commit -q --allow-empty -m initial && git branch -M main", { cwd: tmp });

    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const a = projectIdFromPath(tmp);

    delete process.env.SOCRATICODE_BRANCH_AWARE;
    process.env.SOCRATICODE_BRANCH_AWARE = "true";
    const b = projectIdFromPath(tmp);

    expect(a).toBe(b);
    expect(a).toBe(`${coreProjectId(tmp)}__main`);
    delete process.env.SOCRATICODE_BRANCH_AWARE;
  });
});

describe("sanitization under repo-keying", () => {
  beforeEach(() => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: tmp });
    execSync("git commit -q --allow-empty -m initial", { cwd: tmp });
  });
  afterEach(() => { delete process.env.SOCRATICODE_REPO_KEYING; });

  it("slashy branches use underscores", () => {
    execSync('git checkout -qb "feature/something"', { cwd: tmp });
    const id = projectIdFromPath(tmp);
    expect(id).toMatch(/__feature_something$/);
  });

  it("non-ascii branches collapse to a clean suffix", () => {
    execSync('git checkout -qb "branch-with-dash"', { cwd: tmp });
    const id = projectIdFromPath(tmp);
    expect(id).toMatch(/__branch-with-dash$/);
  });
});

describe("resolveLinkedCollections under repo-keying", () => {
  it("links resolve via path-hash, not repoId", () => {
    process.env.SOCRATICODE_REPO_KEYING = "true";
    const linked = mkdtempSync(join(tmpdir(), "linked-"));
    try {
      writeFileSync(
        join(tmp, ".socraticode.json"),
        JSON.stringify({ linkedProjects: [linked] }),
      );
      const result = resolveLinkedCollections(tmp);
      // Current project + 1 linked
      expect(result).toHaveLength(2);
      // Linked label = basename
      expect(result[1]?.label).toBe(path.basename(linked));
      // Linked collection name uses path-hash, not repoId
      expect(result[1]?.name).toMatch(/^codebase_[0-9a-f]{12}$/);
    } finally {
      rmSync(linked, { recursive: true, force: true });
      delete process.env.SOCRATICODE_REPO_KEYING;
    }
  });
});
