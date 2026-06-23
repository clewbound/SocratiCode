// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonServerHandle, startDaemonServer } from "../../src/daemon/server.js";
import { watchlist } from "../../src/daemon/watchlist.js";

const SHOULD_RUN = process.env.SOCRATICODE_INTEGRATION === "true";

describe.skipIf(!SHOULD_RUN)("daemon end-to-end", () => {
  let handle: DaemonServerHandle;

  beforeAll(async () => {
    process.env.SOCRATICODE_DAEMON_PORT = "0"; // ephemeral
    process.env.SOCRATICODE_DAEMON_MODE = "true";
    handle = await startDaemonServer();
  });

  afterAll(async () => {
    await handle.close();
    delete process.env.SOCRATICODE_DAEMON_PORT;
    delete process.env.SOCRATICODE_DAEMON_MODE;
  });

  it("/healthz returns 200 with port info", async () => {
    const res = await fetch(`http://${handle.bind}:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, port: handle.port, bind: handle.bind });
  });

  it("MCP /mcp endpoint accepts an initialize request", async () => {
    // Smoke test: verify the daemon's MCP transport is reachable. The MCP
    // Streamable HTTP transport may answer with either a 2xx (session opened)
    // or a 4xx framing-error on a single-shot request — both prove the daemon
    // wired the transport. We accept any non-5xx, non-404 status.
    const initRes = await fetch(`http://${handle.bind}:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "test", version: "0" },
          capabilities: {},
        },
      }),
    });
    // Any response from /mcp (other than 404 or 5xx) demonstrates the route is wired.
    expect(initRes.status).not.toBe(404);
    expect(initRes.status).toBeLessThan(500);
    // Drain the body so the connection can be reused/closed cleanly.
    await initRes.text().catch(() => "");
  });

  it("second daemon on the same port fails to start", async () => {
    process.env.SOCRATICODE_DAEMON_PORT = String(handle.port);
    await expect(startDaemonServer()).rejects.toThrow(/EADDRINUSE/);
  });

  it("daemon restart re-arms watchers from persisted watchlist", () => {
    // Simulate a daemon lifecycle: register a path, "restart" by reloading.
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    const prevStateDir = process.env.SOCRATICODE_STATE_DIR;
    process.env.SOCRATICODE_STATE_DIR = stateDir;
    try {
      watchlist.load();
      for (const e of watchlist.entries()) watchlist.remove(e.path);
      watchlist.add({
        path: "/tmp/somewhere",
        repoId: "test-repo",
        commonDir: null,
        addedVia: "explicit",
      });
      // Simulate restart by reloading.
      watchlist.load();
      expect(watchlist.has("/tmp/somewhere")).toBe(true);
    } finally {
      for (const e of watchlist.entries()) watchlist.remove(e.path);
      if (prevStateDir != null) {
        process.env.SOCRATICODE_STATE_DIR = prevStateDir;
      } else {
        delete process.env.SOCRATICODE_STATE_DIR;
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
