import { describe, expect, it } from "vitest";

import { REPLICA_ENGINE_INSPECT_BUSY_TIMEOUT_MS } from "../src/gateway/services/tursoReplica/replicaEngineTableGuard.js";

describe("replicaEngineTableGuard", () => {
  it("uses a short busy timeout so contended opens fail fast", () => {
    expect(REPLICA_ENGINE_INSPECT_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(250);
  });
});
