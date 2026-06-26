// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireProjectLock,
  isProjectLocked,
  releaseAllLocks,
  releaseProjectLock,
} from "../../src/services/lock.js";

let main: string;
let linked: string;

beforeEach(() => {
  process.env.SOCRATICODE_REPO_KEYING = "true";
  main = mkdtempSync(join(tmpdir(), "lock-main-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: main });
  execSync("git commit -q --allow-empty -m initial && git branch -M develop", { cwd: main });
  // Create a sibling tmpdir path for the linked worktree, but remove the directory first
  // so `git worktree add` can create it fresh.
  linked = mkdtempSync(join(tmpdir(), "lock-linked-"));
  rmSync(linked, { recursive: true, force: true });
  // Two worktrees on the same branch: Git's normal safety prevents this, even with
  // --force -B, when the branch is currently checked out elsewhere. We bypass by
  // creating the linked worktree on a temporary branch, then rewriting its HEAD
  // ref to point at `develop` directly. detectGitBranch reads HEAD via
  // `git symbolic-ref --short HEAD`, so both worktrees report `develop`.
  execSync(`git worktree add -q ${linked} -b lock-temp`, { cwd: main });
  execSync("git symbolic-ref HEAD refs/heads/develop", { cwd: linked });
});

afterEach(async () => {
  await releaseAllLocks();
  delete process.env.SOCRATICODE_REPO_KEYING;
  try { execSync(`git worktree remove --force ${linked}`, { cwd: main }); } catch { /* noop */ }
  rmSync(main, { recursive: true, force: true });
  rmSync(linked, { recursive: true, force: true });
});

describe("lock keying under repo-keying", () => {
  it("two paths on the same (repo, branch) share the same lock file", async () => {
    // Acquire via `main`. Because acquireProjectLock is re-entrant within a
    // single process (heldLocks short-circuits), two in-process acquires on
    // the same key both return true — this test instead verifies the
    // *underlying lock file* is shared by observing it via isProjectLocked
    // from the other worktree path. Same lock file ⇒ same projectIdFromPath
    // ⇒ same lock key.
    const acquired = await acquireProjectLock(main, "index");
    expect(acquired).toBe(true);

    // Both paths observe the SAME held lock file because their lock keys
    // collide under repo-keying.
    expect(await isProjectLocked(main, "index")).toBe(true);
    expect(await isProjectLocked(linked, "index")).toBe(true);

    // Releasing from one path releases the shared lock for the other path
    // too (same key ⇒ same heldLocks entry ⇒ same proper-lockfile release).
    await releaseProjectLock(main, "index");
    expect(await isProjectLocked(main, "index")).toBe(false);
    expect(await isProjectLocked(linked, "index")).toBe(false);
  });

  it("different branches on the same repo do NOT share a lock", async () => {
    // Move the linked worktree to a real, separately-checked-out branch
    // (not the symbolic-ref bypass we use in beforeEach).
    execSync("git symbolic-ref HEAD refs/heads/lock-temp", { cwd: linked });
    execSync("git checkout -qb other", { cwd: linked });

    const a = await acquireProjectLock(main, "index");
    const b = await acquireProjectLock(linked, "index");
    expect(a).toBe(true);
    expect(b).toBe(true);

    // Confirm independence: each path sees only its own lock as held.
    expect(await isProjectLocked(main, "index")).toBe(true);
    expect(await isProjectLocked(linked, "index")).toBe(true);

    await releaseProjectLock(main, "index");
    // `linked` still locked because the keys are independent.
    expect(await isProjectLocked(linked, "index")).toBe(true);
  });

  it("different operations on the same (repo, branch) do not share a lock", async () => {
    const a = await acquireProjectLock(main, "index");
    const b = await acquireProjectLock(main, "watch");
    expect(a).toBe(true);
    expect(b).toBe(true);

    // Releasing one operation does not release the other.
    await releaseProjectLock(main, "index");
    expect(await isProjectLocked(main, "index")).toBe(false);
    expect(await isProjectLocked(main, "watch")).toBe(true);
  });
});
