// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "../server-shared.js";
import { logger } from "../services/logger.js";
import { handleAdminRequest } from "./admin-server.js";
import { connectStreamableHttp } from "./transport.js";

const DEFAULT_PORT = 23700;
const DEFAULT_BIND = "127.0.0.1";

export interface DaemonServerHandle {
  port: number;
  bind: string;
  close(): Promise<void>;
}

/**
 * Start the daemon's HTTP MCP server.
 * Binds to SOCRATICODE_DAEMON_BIND:SOCRATICODE_DAEMON_PORT (defaults: 127.0.0.1:23700).
 *
 * When `SOCRATICODE_DAEMON_PORT=0` is set, the OS picks an ephemeral port; the
 * actual port is reported on the returned handle so callers (e.g. integration
 * tests) can dial it without racing on a fixed port.
 */
export async function startDaemonServer(): Promise<DaemonServerHandle> {
  const rawPort = process.env.SOCRATICODE_DAEMON_PORT;
  const parsedPort = rawPort != null && rawPort !== "" ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;
  const requestedPort = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
  const bind = process.env.SOCRATICODE_DAEMON_BIND ?? DEFAULT_BIND;

  const mcp = buildServer();
  const transport = await connectStreamableHttp(mcp);

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const reportedPort = (httpServer.address() as AddressInfo | null)?.port ?? requestedPort;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, port: reportedPort, bind }));
      return;
    }
    if (req.url?.startsWith("/admin/")) {
      await handleAdminRequest(req, res);
      return;
    }
    if (req.url?.startsWith("/mcp")) {
      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        logger.error("MCP transport error", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("internal error");
        }
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, bind, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  // When requestedPort is 0, the OS picks an ephemeral port — report the
  // actual one so callers can dial it.
  const boundPort = (httpServer.address() as AddressInfo | null)?.port ?? requestedPort;

  logger.info("Daemon server listening", { port: boundPort, bind });

  return {
    port: boundPort,
    bind,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.info("Daemon server closed");
    },
  };
}
