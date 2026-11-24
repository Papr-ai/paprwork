import { describe, expect, it } from "vitest";
import { resolvePushOperationsThreshold } from "../../../src/gateway/services/tursoReplica/tursoReplicaConnect.js";

describe("resolvePushOperationsThreshold", () => {
  it("batches pushes by default so a large backlog can drain", () => {
    expect(resolvePushOperationsThreshold(undefined)).toBe(500);
    expect(resolvePushOperationsThreshold("")).toBe(500);
  });

  it("honours an explicit override", () => {
    expect(resolvePushOperationsThreshold("200")).toBe(200);
    expect(resolvePushOperationsThreshold("250.7")).toBe(250);
  });

  it("0 disables batching (engine sends one batch)", () => {
    expect(resolvePushOperationsThreshold("0")).toBeUndefined();
  });

  it("falls back to the default on junk", () => {
    expect(resolvePushOperationsThreshold("abc")).toBe(500);
    expect(resolvePushOperationsThreshold("-5")).toBe(500);
  });
});
