// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { describe, it } from "vitest";

// Full daemon-admin integration test (start daemon → register path →
// GET /admin/watchlist → assert enriched shape) is deferred. Phase 7's
// unit tests cover the CLI dispatch + error paths; the admin routes
// themselves are exercised by the existing daemon end-to-end suite.
//
// Tracking the same pattern as phase 5's lazy-detached test: stub here,
// real coverage lands when the broader integration harness is extended.
describe.skip("daemon admin endpoints (integration)", () => {
  it("admin /watchlist returns entries enriched with currentBranch", async () => {
    // start daemon, register a path, GET /admin/watchlist, assert shape.
  });
});
