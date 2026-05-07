// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { logger } from "../services/logger.js";
import { getClient } from "../services/qdrant.js";

/**
 * Match `<prefix><pathhash>(__<branch>)?(_symgraph_(meta|file|index))?` where
 * `<pathhash>` is a 12-hex chunk produced by the legacy `coreProjectId` (sha256
 * of an absolute path). This deliberately accepts the daemon-era repo-keyed
 * shape too — the migration is about renaming legacy entries, not exotic
 * collection names — so callers must still rule out the active repo-keyed
 * format before warning.
 */
const LEGACY_NAME_RE =
  /^(codebase_|codegraph_|context_)?[0-9a-f]{12}(__[A-Za-z0-9_-]+)?(_symgraph_(?:meta|file|index))?$/;

/**
 * Scan Qdrant for legacy <pathhash>__<branch> collections and log a
 * one-line suggestion if found. Non-fatal: any error is swallowed by the
 * caller (which only `.catch` logs at debug).
 */
export async function detectLegacyCollections(): Promise<void> {
  const qdrant = getClient();
  const { collections } = await qdrant.getCollections();
  const legacy = collections.map((c) => c.name).filter((n) => LEGACY_NAME_RE.test(n));
  if (legacy.length === 0) return;
  logger.warn(
    `Detected ${legacy.length} legacy <pathhash>__<branch> collection(s). ` +
      "Run `socraticode migrate-legacy-keying --dry-run` to preview a rename, " +
      "or remove this notice by completing migration.",
  );
}
