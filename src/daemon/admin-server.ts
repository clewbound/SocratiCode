// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import type http from "node:http";
import { detectGitBranchFromHead } from "../config.js";
import { logger } from "../services/logger.js";
import { isWatching } from "../services/watcher.js";
import { runCollectionGc, runWatchlistGc } from "./gc.js";
import { registerPath, watchlist } from "./watchlist.js";

/**
 * Handle an HTTP request whose pathname starts with `/admin/`.
 *
 * Routes:
 *   GET  /admin/status     → daemon health summary
 *   GET  /admin/watchlist  → registered paths enriched with branch + watcher state
 *   POST /admin/watch      → register a path (body: { path, sticky? })
 *   POST /admin/unwatch    → remove a path (body: { path, gcCollections? })
 *   POST /admin/gc         → run watchlist + collection GC (body: { dryRun? })
 */
export async function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname === "/admin/status" && req.method === "GET") {
      return json(200, {
        ok: true,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        watchlistSize: watchlist.entries().length,
      });
    }

    if (url.pathname === "/admin/watchlist" && req.method === "GET") {
      const enriched = watchlist.entries().map((e) => ({
        ...e,
        currentBranch: detectGitBranchFromHead(e.path),
        isWatching: isWatching(e.path),
      }));
      return json(200, { entries: enriched });
    }

    if (url.pathname === "/admin/watch" && req.method === "POST") {
      const body = await readJson(req);
      const sticky = Boolean(body?.sticky ?? true);
      if (typeof body?.path !== "string") {
        return json(400, { error: "path required" });
      }
      await registerPath(body.path, sticky ? "explicit" : "implicit");
      return json(200, { ok: true });
    }

    if (url.pathname === "/admin/unwatch" && req.method === "POST") {
      const body = await readJson(req);
      const target = typeof body?.path === "string" ? body.path : "";
      const removed = watchlist.remove(target);
      // body.gcCollections is accepted but not yet wired — phase 8's
      // runCollectionGc will pick up orphaned collections on the next sweep.
      return json(200, { ok: removed });
    }

    if (url.pathname === "/admin/gc" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const dryRun = Boolean(body?.dryRun);
      const wlReport = await runWatchlistGc({ dryRun });
      const colReport = await runCollectionGc({ dryRun });
      return json(200, { dryRun, watchlist: wlReport, collections: colReport });
    }

    return json(404, { error: "not found" });
  } catch (err) {
    logger.error("admin route error", {
      url: url.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "internal error" });
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
