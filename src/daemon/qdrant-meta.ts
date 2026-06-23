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
 * Read `markedDeadAt` for many collections in a single Qdrant `retrieve`
 * call. Returns a Map with one entry per requested name — `null` when the
 * metadata point is missing, the `markedDeadAt` key is absent, or the
 * payload value isn't a number. On retrieve failure the whole map is
 * filled with `null` so the gc sweep degrades to "no collections marked"
 * rather than crashing.
 *
 * Replaces a per-collection sequential loop. For ~34 collections this
 * collapses the wall time of the read step from ~600ms (one RTT each) to
 * a single RTT.
 */
export async function batchGetMarkedDeadAt(
  collNames: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (collNames.length === 0) return out;
  await ensureMetadataCollection();
  const nameById = new Map<string, string>();
  for (const name of collNames) {
    nameById.set(metadataPointId(name), name);
    out.set(name, null);
  }
  try {
    const points = await getClient().retrieve(METADATA_COLLECTION, {
      ids: [...nameById.keys()],
      with_payload: ["markedDeadAt"],
    });
    for (const p of points) {
      const name = nameById.get(String(p.id));
      if (!name) continue;
      const v = p.payload?.markedDeadAt;
      if (typeof v === "number") out.set(name, v);
    }
  } catch {
    // out is already populated with null for every requested name
  }
  return out;
}

/**
 * Stamp the metadata point with `markedDeadAt: <ts>`. Uses `setPayload` so
 * existing payload (project metadata, hashes, etc.) is preserved when the
 * point already exists.
 *
 * When Qdrant reports the metadata point does not exist — which happens for
 * symgraph subordinate collections and any legacy collection created before
 * metadata-point side-effects were wired — fall back to `upsert` with a
 * placeholder vector so the two-step GC protocol can still advance. Without
 * this fallback `setPayload` throws and the GC sweep records a permanent
 * failure for that collection, defeating the purpose of GC.
 *
 * Throws on other Qdrant errors so the GC sweep can record the failure in
 * its report.
 */
export async function setMarkedDeadAt(collName: string, ts: number): Promise<void> {
  await ensureMetadataCollection();
  const id = metadataPointId(collName);
  const client = getClient();
  try {
    await client.setPayload(METADATA_COLLECTION, {
      points: [id],
      payload: { markedDeadAt: ts },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Qdrant: "Not found: No point with id <uuid> found"
    if (!/Not found|No point with id/i.test(msg)) throw err;
    await client.upsert(METADATA_COLLECTION, {
      points: [{ id, vector: [0], payload: { markedDeadAt: ts } }],
    });
  }
}

/**
 * Remove the `markedDeadAt` key from the metadata point. Called when a
 * branch is resurrected within the grace period so the next sweep doesn't
 * re-evaluate the collection as dead with stale timing.
 *
 * When Qdrant reports the metadata point does not exist, treat as a no-op:
 * there is no `markedDeadAt` to clear, so the desired post-state is already
 * achieved. Symmetric to the upsert fallback in {@link setMarkedDeadAt} —
 * keeps the call idempotent under races with point deletion and avoids
 * spurious "best-effort failed" warnings in gc logs.
 *
 * Throws on other Qdrant errors so callers can surface real failures.
 */
export async function clearMarkedDeadAt(collName: string): Promise<void> {
  await ensureMetadataCollection();
  const id = metadataPointId(collName);
  try {
    await getClient().deletePayload(METADATA_COLLECTION, {
      points: [id],
      keys: ["markedDeadAt"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Not found|No point with id/i.test(msg)) throw err;
  }
}
