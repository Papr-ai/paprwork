import { describe, expect, it } from "vitest";
import { computeReplicaPendingPush } from "../src/gateway/services/tursoReplica/replicaPendingPush.js";

describe("computeReplicaPendingPush", () => {
  it("is pending when CDC ops remain", () => {
    expect(
      computeReplicaPendingPush({
        pendingOps: 2,
        lastPushError: null,
      }),
    ).toBe(true);
  });

  it("is not pending when CDC counter is stale after successful push", () => {
    expect(
      computeReplicaPendingPush({
        pendingOps: 15,
        lastPushError: null,
        lastReplicaLocalMutationAt: "2026-09-06T11:00:00.000Z",
        lastReplicaPushAt: "2026-09-06T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("is pending when push error has no successful push after last mutation", () => {
    expect(
      computeReplicaPendingPush({
        pendingOps: 0,
        lastPushError: "short read on WAL frame",
        lastReplicaLocalMutationAt: "2026-09-06T12:00:00.000Z",
        lastReplicaPushAt: "2026-09-06T11:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("is not pending when push succeeded after last mutation despite stale error text", () => {
    expect(
      computeReplicaPendingPush({
        pendingOps: 0,
        lastPushError: "short read on WAL frame",
        lastReplicaLocalMutationAt: "2026-09-06T11:00:00.000Z",
        lastReplicaPushAt: "2026-09-06T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("is not pending when mutation timestamp trails push by a few ms with zero CDC ops", () => {
    expect(
      computeReplicaPendingPush({
        pendingOps: 0,
        lastReplicaPushAt: "2026-09-07T06:24:57.811Z",
        lastReplicaLocalMutationAt: "2026-09-07T06:24:57.826Z",
      }),
    ).toBe(false);
  });

  it("is pending when local mutation never pushed", () => {
    expect(
      computeReplicaPendingPush({
        pendingOps: 0,
        lastReplicaLocalMutationAt: "2026-09-06T12:00:00.000Z",
      }),
    ).toBe(true);
  });
});
