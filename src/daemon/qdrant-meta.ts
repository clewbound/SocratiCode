// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Helpers for the `markedDeadAt` field used by the two-step collection GC
 * (see `src/daemon/gc.ts`). The field lives on the per-collection metadata
 * point in the shared {@link METADATA_COLLECTION}, keyed by
 * `metadataPointId(collName)` — same convention as every other piece of
 * metadata (hashes, gitBlobShas, graphData, etc.).
 *
 * Persisting this state in Qdrant (rather than daemon memory) is what makes
 * the two-step protocol survive daemon restarts and tolerate branch
 * resurrection without losing the grace-period clock.
 */

import { ensureMetadataCollection, getClient, METADATA_COLLECTION, metadataPointId } from "../services/qdrant.js";

/**
 * Read `markedDeadAt` from the metadata point for the given collection.
 *
 * Returns:
 *   - `null` when the metadata point doesn't exist, has no `markedDeadAt`
 *     payload key, or any read error occurs (the collection GC sweep treats
 *     this as "not yet marked").
 *   - the timestamp (milliseconds since epoch) otherwise.
 */
export async function getMarkedDeadAt(collName: string): Promise<number | null> {
  try {
    await ensureMetadataCollection();
    const id = metadataPointId(collName);
    const points = await getClient().retrieve(METADATA_COLLECTION, {
      ids: [id],
      with_payload: ["markedDeadAt"],
    });
    if (points.length === 0) return null;
    const v = points[0].payload?.markedDeadAt;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Stamp the metadata point with `markedDeadAt: <ts>`. Uses `setPayload` so
 * the existing payload (project metadata, hashes, etc.) is preserved.
 *
 * Throws on Qdrant errors so the GC sweep can record the failure in its
 * report rather than silently moving on.
 */
export async function setMarkedDeadAt(collName: string, ts: number): Promise<void> {
  await ensureMetadataCollection();
  const id = metadataPointId(collName);
  await getClient().setPayload(METADATA_COLLECTION, {
    points: [id],
    payload: { markedDeadAt: ts },
  });
}

/**
 * Remove the `markedDeadAt` key from the metadata point. Called when a
 * branch is resurrected within the grace period so the next sweep doesn't
 * re-evaluate the collection as dead with stale timing.
 *
 * Throws on Qdrant errors; callers treat this as best-effort.
 */
export async function clearMarkedDeadAt(collName: string): Promise<void> {
  await ensureMetadataCollection();
  const id = metadataPointId(collName);
  await getClient().deletePayload(METADATA_COLLECTION, {
    points: [id],
    keys: ["markedDeadAt"],
  });
}
