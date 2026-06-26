// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "../services/logger.js";

/**
 * Connect an McpServer to a Streamable HTTP transport.
 * The transport handles MCP-over-HTTP framing including SSE for server-sent events.
 *
 * Returns the transport so the caller can wire it into an HTTP request handler.
 */
export async function connectStreamableHttp(server: McpServer): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false, // SSE-streaming responses
  });
  await server.connect(transport);
  logger.info("MCP HTTP/SSE transport connected");
  return transport;
}
