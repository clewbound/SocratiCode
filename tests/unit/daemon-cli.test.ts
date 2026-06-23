// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/daemon-cli.js";

describe("daemon CLI", () => {
  it("prints usage on unknown subcommand", async () => {
    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      errs.push(s);
      return true;
    };
    try {
      const code = await main(["wat"]);
      expect(code).toBe(1);
      expect(errs.join("")).toMatch(/usage:/);
    } finally {
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    }
  });

  it("returns clear error when daemon is not running", async () => {
    // Bind an ephemeral port, capture the assigned port, then close the server.
    // The freed port is almost certainly closed (no listener) — much more
    // reliable than picking port 1, which on macOS may behave oddly.
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", () => r()));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));

    process.env.SOCRATICODE_DAEMON_ADMIN_URL = `http://127.0.0.1:${port}/admin`;
    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      errs.push(s);
      return true;
    };
    try {
      const code = await main(["status"]);
      expect(code).toBe(2);
      expect(errs.join("")).toMatch(/Is the daemon running/);
    } finally {
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
      delete process.env.SOCRATICODE_DAEMON_ADMIN_URL;
    }
  });
});
