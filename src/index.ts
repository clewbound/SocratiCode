#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server-shared.js";
import { logger, setMcpLogSender } from "./services/logger.js";
import { autoResumeIndexedProjects, gracefulShutdown } from "./services/startup.js";

const server = buildServer();

// Forward every logger call as an MCP notifications/message so hosts like Cline
// display log lines in their UI (Cline's stderr path drops the content in non-DEV mode).
setMcpLogSender((params) => {
  server.server.sendLoggingMessage(params).catch(() => {
    // Ignore — transport may not be connected yet during startup.
  });
});

// ── Start server ─────────────────────────────────────────────────────────

async function main() {
  const subcommand = process.argv[2];

  if (subcommand === "daemon") {
    const rest = process.argv.slice(3);
    if (rest.length === 0) {
      const { main: daemonMain } = await import("./daemon/index.js");
      const code = await daemonMain();
      process.exit(code);
    }
    const { main: cliMain } = await import("./cli/daemon-cli.js");
    const code = await cliMain(rest);
    process.exit(code);
  }
  if (subcommand === "migrate-legacy-keying") {
    const { main: migrateMain } = await import("./cli/migrate-legacy-keying.js");
    const code = await migrateMain(process.argv.slice(3));
    process.exit(code);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Auto-resume watchers and incremental updates for already-indexed projects
  // Fire-and-forget — runs in background, non-blocking, non-fatal
  autoResumeIndexedProjects();

  // ── Process-level error handlers ─────────────────────────────────────

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", {
      error: err.message,
      stack: err.stack,
    });
    // Uncaught exceptions leave the process in an undefined state — exit
    process.exit(1);
  });

  // ── Graceful shutdown ────────────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // prevent double shutdown
    shuttingDown = true;
    await gracefulShutdown(signal, () => server.close());
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Stdin pipe-break detection ─────────────────────────────────────────
  // When the MCP host (e.g. Cline/VS Code) closes its side of the stdio pipe,
  // Node.js may emit 'end', 'error', or 'close' on stdin depending on how
  // abruptly the pipe was severed. A clean close emits 'end'; an abrupt
  // break (e.g. heavy I/O during indexing) may skip 'end' and only emit
  // 'error' + 'close'. Listen for all three to catch every scenario.
  // The shuttingDown guard in shutdown() prevents double-shutdown.
  process.stdin.on("end", () => shutdown("stdin EOF"));
  process.stdin.on("error", () => shutdown("stdin error"));
  process.stdin.on("close", () => shutdown("stdin close"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
