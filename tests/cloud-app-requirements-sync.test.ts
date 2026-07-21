import { describe, expect, it } from "vitest";
import {
  mergeBackendKeysIntoRequirements,
  readAppRequirements,
} from "../src/gateway/services/cloudAppRequirements.js";

describe("cloudAppRequirements backend key sync", () => {
  it("merges backend manifest keys as owner-scoped server requirements", () => {
    const merged = mergeBackendKeysIntoRequirements(
      [],
      ["RR_ATTENTION_API_KEY", "NEON_DB_URL"],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.name).toBe("RR_ATTENTION_API_KEY");
    expect(merged[0]?.credentialScope).toBe("owner");
    expect(merged[0]?.clientAccess).toBe("server");
    expect(merged[1]?.name).toBe("NEON_DB_URL");
  });

  it("does not duplicate existing requirements", () => {
    const existing = mergeBackendKeysIntoRequirements([], ["RR_ATTENTION_API_KEY"]);
    const merged = mergeBackendKeysIntoRequirements(existing, [
      "RR_ATTENTION_API_KEY",
    ]);
    expect(merged).toHaveLength(1);
  });

  it("readAppRequirements returns empty when file missing", () => {
    expect(readAppRequirements("/nonexistent/papr", "app-id")).toEqual([]);
  });
});
