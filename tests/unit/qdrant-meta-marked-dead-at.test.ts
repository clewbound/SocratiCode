// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { beforeEach, describe, expect, it, vi } from "vitest";

const setPayloadMock = vi.fn();
const upsertMock = vi.fn();
const deletePayloadMock = vi.fn();
const retrieveMock = vi.fn();

vi.mock("../../src/services/qdrant.js", () => ({
  METADATA_COLLECTION: "socraticode_metadata",
  metadataPointId: (name: string) => `point-id-${name}`,
  ensureMetadataCollection: vi.fn(async () => {}),
  getClient: () => ({
    setPayload: setPayloadMock,
    upsert: upsertMock,
    deletePayload: deletePayloadMock,
    retrieve: retrieveMock,
  }),
}));

const { setMarkedDeadAt, clearMarkedDeadAt, batchGetMarkedDeadAt } = await import(
  "../../src/daemon/qdrant-meta.js"
);

describe("setMarkedDeadAt", () => {
  beforeEach(() => {
    setPayloadMock.mockReset();
    upsertMock.mockReset();
  });

  it("uses setPayload in the happy path (point already exists)", async () => {
    setPayloadMock.mockResolvedValueOnce(undefined);
    await setMarkedDeadAt("codebase_abc__develop", 12345);
    expect(setPayloadMock).toHaveBeenCalledTimes(1);
    expect(setPayloadMock).toHaveBeenCalledWith("socraticode_metadata", {
      points: ["point-id-codebase_abc__develop"],
      payload: { markedDeadAt: 12345 },
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  // Without the upsert fallback, setMarkedDeadAt threw and the gc protocol
  // could never advance past the first sweep for any collection whose
  // metadata point didn't already exist (symgraph subordinates, legacy
  // collections created before the metadata-point side-effect, etc.).
  it("falls back to upsert when Qdrant reports the point is missing", async () => {
    setPayloadMock.mockRejectedValueOnce(
      new Error("Not found: No point with id point-id-foo found"),
    );
    upsertMock.mockResolvedValueOnce(undefined);

    await setMarkedDeadAt("foo", 99);

    expect(setPayloadMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [coll, body] = upsertMock.mock.calls[0];
    expect(coll).toBe("socraticode_metadata");
    expect(body.points[0]).toMatchObject({
      id: "point-id-foo",
      payload: { markedDeadAt: 99 },
    });
    // The placeholder vector must be present so Qdrant accepts the point.
    expect(Array.isArray(body.points[0].vector)).toBe(true);
  });

  it("matches the 'No point with id' shape returned by the HTTP API", async () => {
    setPayloadMock.mockRejectedValueOnce(
      new Error('{"status":{"error":"Not found: No point with id X"}}'),
    );
    upsertMock.mockResolvedValueOnce(undefined);
    await setMarkedDeadAt("bar", 1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("re-throws other Qdrant errors (network, auth, etc.)", async () => {
    setPayloadMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(setMarkedDeadAt("x", 1)).rejects.toThrow("ECONNREFUSED");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("clearMarkedDeadAt", () => {
  beforeEach(() => {
    deletePayloadMock.mockReset();
  });

  it("uses deletePayload in the happy path (point exists)", async () => {
    deletePayloadMock.mockResolvedValueOnce(undefined);
    await clearMarkedDeadAt("codebase_abc__develop");
    expect(deletePayloadMock).toHaveBeenCalledTimes(1);
    expect(deletePayloadMock).toHaveBeenCalledWith("socraticode_metadata", {
      points: ["point-id-codebase_abc__develop"],
      keys: ["markedDeadAt"],
    });
  });

  // Symmetric to setMarkedDeadAt's upsert fallback: when the metadata point
  // doesn't exist there is nothing to clear, so the call is a no-op rather
  // than an error. Without this, a race between read and write — or any
  // out-of-band point deletion — would surface as a spurious warning in the
  // gc sweep log.
  it("swallows 'Not found' silently (idempotent no-op)", async () => {
    deletePayloadMock.mockRejectedValueOnce(
      new Error("Not found: No point with id point-id-foo found"),
    );
    await expect(clearMarkedDeadAt("foo")).resolves.toBeUndefined();
  });

  it("matches the 'No point with id' shape returned by the HTTP API", async () => {
    deletePayloadMock.mockRejectedValueOnce(
      new Error('{"status":{"error":"Not found: No point with id X"}}'),
    );
    await expect(clearMarkedDeadAt("bar")).resolves.toBeUndefined();
  });

  it("re-throws other Qdrant errors (network, auth, etc.)", async () => {
    deletePayloadMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(clearMarkedDeadAt("x")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("batchGetMarkedDeadAt", () => {
  beforeEach(() => {
    retrieveMock.mockReset();
  });

  it("returns an empty map without hitting Qdrant when given no names", async () => {
    const out = await batchGetMarkedDeadAt([]);
    expect(out.size).toBe(0);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("retrieves all metadata points in a single call and maps them by collection name", async () => {
    retrieveMock.mockResolvedValueOnce([
      { id: "point-id-a", payload: { markedDeadAt: 100 } },
      { id: "point-id-b", payload: { markedDeadAt: 200 } },
    ]);
    const out = await batchGetMarkedDeadAt(["a", "b"]);
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(retrieveMock).toHaveBeenCalledWith("socraticode_metadata", {
      ids: ["point-id-a", "point-id-b"],
      with_payload: ["markedDeadAt"],
    });
    expect(out.get("a")).toBe(100);
    expect(out.get("b")).toBe(200);
  });

  // Qdrant retrieve silently omits IDs that don't exist; the helper must
  // backfill those keys as null so callers can treat the map as a complete
  // lookup table over the requested set.
  it("returns null for collections whose metadata point is missing", async () => {
    retrieveMock.mockResolvedValueOnce([
      { id: "point-id-present", payload: { markedDeadAt: 123 } },
    ]);
    const out = await batchGetMarkedDeadAt(["present", "missing-1", "missing-2"]);
    expect(out.get("present")).toBe(123);
    expect(out.get("missing-1")).toBeNull();
    expect(out.get("missing-2")).toBeNull();
  });

  it("returns null when markedDeadAt is present but not a number", async () => {
    retrieveMock.mockResolvedValueOnce([
      { id: "point-id-a", payload: { markedDeadAt: "garbage" } },
      { id: "point-id-b", payload: {} },
    ]);
    const out = await batchGetMarkedDeadAt(["a", "b"]);
    expect(out.get("a")).toBeNull();
    expect(out.get("b")).toBeNull();
  });

  // Fail-open: a transient Qdrant failure must not crash the gc sweep. The
  // sweep treats null as "not yet marked", so the worst-case outcome is one
  // extra mark-dead pass next cycle — never a deletion.
  it("returns all-null on retrieve failure (fail-open for the gc sweep)", async () => {
    retrieveMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const out = await batchGetMarkedDeadAt(["a", "b"]);
    expect(out.get("a")).toBeNull();
    expect(out.get("b")).toBeNull();
  });
});
