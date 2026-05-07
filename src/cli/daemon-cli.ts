// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:23700/admin";

function base(): string {
  return process.env.SOCRATICODE_DAEMON_ADMIN_URL ?? DEFAULT_BASE;
}

async function adminGet(routePath: string): Promise<unknown> {
  const res = await fetch(`${base()}${routePath}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function adminPost(routePath: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base()}${routePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function status(): Promise<number> {
  const out = await adminGet("/status");
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

interface WatchlistEntryView {
  path: string;
  repoId: string;
  addedVia: string;
  currentBranch: string | null;
  isWatching: boolean;
}

async function watchlistCmd(): Promise<number> {
  const out = (await adminGet("/watchlist")) as { entries?: WatchlistEntryView[] };
  for (const e of out.entries ?? []) {
    process.stdout.write(
      `${e.path}  repo=${e.repoId}  branch=${e.currentBranch ?? "(detached)"}  via=${e.addedVia}  watching=${e.isWatching}\n`,
    );
  }
  return 0;
}

async function watchCmd(args: string[]): Promise<number> {
  const sticky = !args.includes("--no-sticky"); // default sticky for explicit add
  const argPath = args.find((a) => !a.startsWith("--"));
  if (!argPath) {
    process.stderr.write("usage: socraticode daemon watch <path> [--no-sticky]\n");
    return 1;
  }
  const resolved = path.resolve(argPath);
  await adminPost("/watch", { path: resolved, sticky });
  process.stdout.write(`watching ${resolved}${sticky ? " (sticky)" : ""}\n`);
  return 0;
}

async function unwatchCmd(args: string[]): Promise<number> {
  const argPath = args.find((a) => !a.startsWith("--"));
  if (!argPath) {
    process.stderr.write("usage: socraticode daemon unwatch <path> [--gc-collections]\n");
    return 1;
  }
  const gcCollections = args.includes("--gc-collections");
  const resolved = path.resolve(argPath);
  const out = (await adminPost("/unwatch", {
    path: resolved,
    gcCollections,
  })) as { ok?: boolean };
  process.stdout.write(out.ok ? `unwatched ${resolved}\n` : `not in watchlist: ${resolved}\n`);
  return 0;
}

async function gcCmd(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const out = await adminPost("/gc", { dryRun });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "status":
        return await status();
      case "watchlist":
        return await watchlistCmd();
      case "watch":
        return await watchCmd(rest);
      case "unwatch":
        return await unwatchCmd(rest);
      case "gc":
        return await gcCmd(rest);
      default:
        process.stderr.write(
          "usage: socraticode daemon <status|watchlist|watch|unwatch|gc>\n" +
            "       (no arg starts the daemon; with arg this is the CLI client)\n",
        );
        return 1;
    }
  } catch (err) {
    process.stderr.write(
      `daemon CLI error: ${err instanceof Error ? err.message : String(err)}\n` +
        `Is the daemon running? Try: launchctl start com.socraticode.daemon\n`,
    );
    return 2;
  }
}
