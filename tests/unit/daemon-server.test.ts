// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemonServer } from "../../src/daemon/server.js";
import { buildServer } from "../../src/server-shared.js";

describe("buildServer", () => {
  it("registers all expected tool names", () => {
    const server = buildServer();
    // McpServer (SDK 1.26) stores tools on a private `_registeredTools` field
    // as a plain object keyed by tool name. The accessor below is intentionally
    // permissive so a future SDK migration to a Map keeps the test working.
    const reg = (server as unknown as { _registeredTools: Record<string, unknown> | Map<string, unknown> })
      ._registeredTools;
    const names = reg instanceof Map ? Array.from(reg.keys()) : Object.keys(reg ?? {});
    expect(names).toEqual(
      expect.arrayContaining([
        "codebase_index",
        "codebase_update",
        "codebase_remove",
        "codebase_stop",
        "codebase_watch",
        "codebase_search",
        "codebase_status",
        "codebase_graph_build",
        "codebase_graph_query",
        "codebase_graph_stats",
        "codebase_graph_circular",
        "codebase_graph_visualize",
        "codebase_graph_remove",
        "codebase_graph_status",
        "codebase_impact",
        "codebase_flow",
        "codebase_symbol",
        "codebase_symbols",
        "codebase_context",
        "codebase_context_search",
        "codebase_context_index",
        "codebase_context_remove",
        "codebase_health",
        "codebase_list_projects",
        "codebase_about",
      ]),
    );
  });
});

describe("startDaemonServer", () => {
  let blocker: http.Server | undefined;

  afterEach(async () => {
    if (blocker) {
      await new Promise<void>((r) => blocker?.close(() => r()));
      blocker = undefined;
    }
    delete process.env.SOCRATICODE_DAEMON_PORT;
  });

  it("reports a clear error if port is already in use", async () => {
    // Block an ephemeral port first, then point the daemon at it.
    blocker = http.createServer();
    await new Promise<void>((r) => blocker?.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as AddressInfo).port;
    process.env.SOCRATICODE_DAEMON_PORT = String(port);

    await expect(startDaemonServer()).rejects.toThrow(/EADDRINUSE/);
  });
});
