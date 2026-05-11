// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { beforeEach, describe, expect, it, vi } from "vitest";

const setPayloadMock = vi.fn();
const upsertMock = vi.fn();

vi.mock("../../src/services/qdrant.js", () => ({
  METADATA_COLLECTION: "socraticode_metadata",
  metadataPointId: (name: string) => `point-id-${name}`,
  ensureMetadataCollection: vi.fn(async () => {}),
  getClient: () => ({
    setPayload: setPayloadMock,
    upsert: upsertMock,
  }),
}));

const { setMarkedDeadAt } = await import("../../src/daemon/qdrant-meta.js");

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
