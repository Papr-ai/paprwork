import { describe, expect, it } from "vitest";
import {
  isReplicaCheckpointWalError,
  isReplicaNetworkFetchError,
  isReplicaReadTransportError,
} from "../src/gateway/services/tursoReplica/tursoReplicaCheckpointRecovery.js";
import { isReplicaMissingTableError } from "../src/gateway/services/tursoReplica/tursoReplicaSchemaDriftHeal.js";
import { CHECKPOINT_WAL_ERROR } from "./helpers/tursoReplicaBridgeMock.js";

describe("tursoReplicaCheckpointRecovery", () => {
  it("treats real checkpoint WAL errors as checkpoint failures", () => {
    expect(isReplicaCheckpointWalError(CHECKPOINT_WAL_ERROR)).toBe(true);
    expect(
      isReplicaCheckpointWalError(
        'short read on WAL frame at offset 1730432: expected 4096 bytes, got 0',
      ),
    ).toBe(true);
  });

  it("does not treat network fetch failures as checkpoint WAL errors", () => {
    const fetchFailed =
      "sync engine operation failed: database sync engine error: fetch error: TypeError: fetch failed";
    expect(isReplicaNetworkFetchError(fetchFailed)).toBe(true);
    expect(isReplicaCheckpointWalError(fetchFailed)).toBe(false);
    expect(isReplicaReadTransportError(fetchFailed)).toBe(true);
  });

  it("does not treat connect timeouts as checkpoint WAL errors", () => {
    const timeout =
      "Connect Timeout Error (attempted address: server.papr.ai:443, timeout: 10000ms)";
    expect(isReplicaNetworkFetchError(timeout)).toBe(true);
    expect(isReplicaCheckpointWalError(timeout)).toBe(false);
  });
});

describe("tursoReplicaSchemaDriftHeal", () => {
  it("detects missing-table errors from replica prepare failures", () => {
    expect(
      isReplicaMissingTableError(
        "prepare failed: Parse error: no such table: brief_reviews",
      ),
    ).toBe(true);
    expect(isReplicaMissingTableError("no such table: goals")).toBe(true);
    expect(isReplicaMissingTableError("timed out after 2500ms")).toBe(false);
  });
});
