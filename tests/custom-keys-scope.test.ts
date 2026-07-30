import { describe, expect, it } from "vitest";
import {
  isGlobalCustomKeyName,
  isPaprPlatformApiKeyName,
} from "../src/core/storage/customKeysScope.js";

describe("customKeysScope", () => {
  it("recognizes Papr platform API key names", () => {
    expect(isPaprPlatformApiKeyName("PAPR_API_KEY")).toBe(true);
    expect(isPaprPlatformApiKeyName("PAPR_API_KEY__VIA2C5VDxj")).toBe(true);
    expect(isPaprPlatformApiKeyName("NEON_DATABASE_URL")).toBe(false);
  });

  it("does not treat Papr platform keys as global session keys", () => {
    expect(isGlobalCustomKeyName("PAPR_API_KEY")).toBe(false);
    expect(isGlobalCustomKeyName("PAPR_SESSION_TOKEN")).toBe(true);
  });
});
