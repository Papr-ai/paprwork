import { describe, expect, it } from "vitest";
import { digestsMatch } from "../src/gateway/services/cloudSync/convergenceHash.js";

describe("convergenceHash", () => {
  it("detects row count drift", () => {
    const local = {
      tableName: "items",
      rowCount: 2,
      contentHash: "abc123",
    };
    const remote = {
      tableName: "items",
      rowCount: 3,
      contentHash: "abc123",
    };
    expect(digestsMatch(local, remote)).toBe(false);
  });

  it("detects content hash drift", () => {
    const local = {
      tableName: "items",
      rowCount: 2,
      contentHash: "abc123",
    };
    const remote = {
      tableName: "items",
      rowCount: 2,
      contentHash: "def456",
    };
    expect(digestsMatch(local, remote)).toBe(false);
  });
});
