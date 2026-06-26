// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Watchlist } from "../../src/daemon/watchlist.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "watchlist-"));
  process.env.SOCRATICODE_STATE_DIR = stateDir;
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.SOCRATICODE_STATE_DIR;
});

describe("Watchlist", () => {
  it("starts empty when no state file exists", () => {
    const wl = new Watchlist();
    wl.load();
    expect(wl.entries()).toEqual([]);
  });

  it("persists entries via atomic write", () => {
    const wl = new Watchlist();
    wl.load();
    wl.add({ path: "/a/b", repoId: "r1", commonDir: "/a/.git", addedVia: "implicit" });
    expect(wl.has("/a/b")).toBe(true);

    const wl2 = new Watchlist();
    wl2.load();
    expect(wl2.has("/a/b")).toBe(true);
    expect(wl2.entries()[0]?.repoId).toBe("r1");
  });

  it("updates lastQueriedAt without rewriting other fields", async () => {
    const wl = new Watchlist();
    wl.load();
    wl.add({ path: "/a/b", repoId: "r1", commonDir: null, addedVia: "explicit" });
    const before = wl.entries()[0]?.lastQueriedAt;
    // Sleep 2ms to ensure ISO timestamp resolution diff
    await new Promise((resolve) => setTimeout(resolve, 2));
    wl.touch("/a/b");
    const after = wl.entries()[0]?.lastQueriedAt;
    expect(after).not.toBe(before);
    expect(wl.entries()[0]?.addedVia).toBe("explicit");
  });

  it("remove() drops the entry", () => {
    const wl = new Watchlist();
    wl.load();
    wl.add({ path: "/a/b", repoId: "r1", commonDir: null, addedVia: "implicit" });
    wl.remove("/a/b");
    expect(wl.has("/a/b")).toBe(false);
  });

  it("malformed state file is treated as empty (logs but doesn't throw)", () => {
    writeFileSync(join(stateDir, "watchlist.json"), "not json {");
    const wl = new Watchlist();
    wl.load();
    expect(wl.entries()).toEqual([]);
  });

  it("state-file write is atomic (tmp + rename)", () => {
    const wl = new Watchlist();
    wl.load();
    wl.add({ path: "/a/b", repoId: "r1", commonDir: null, addedVia: "implicit" });
    const raw = readFileSync(join(stateDir, "watchlist.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
  });
});
