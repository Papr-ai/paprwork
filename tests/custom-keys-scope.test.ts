import { describe, expect, it } from "vitest";
import {
  GLOBAL_CUSTOM_KEY_NAMES,
  isGlobalCustomKeyName,
} from "../src/core/storage/customKeysScope.js";

describe("customKeysScope", () => {
  it("marks session/auth keys as global", () => {
    expect(isGlobalCustomKeyName("PAPR_SESSION_TOKEN")).toBe(true);
    expect(isGlobalCustomKeyName("papr_refresh_token")).toBe(true);
    expect(isGlobalCustomKeyName("PAPR_ACCESS_TOKEN")).toBe(true);
  });

  it("treats integration keys as org-scoped", () => {
    expect(isGlobalCustomKeyName("OPENAI_API_KEY")).toBe(false);
    expect(isGlobalCustomKeyName("PAPR_API_KEY")).toBe(false);
    expect(isGlobalCustomKeyName("STRIPE_SECRET_KEY")).toBe(false);
  });

  it("includes expected global key names", () => {
    expect(GLOBAL_CUSTOM_KEY_NAMES.has("PAPR_SESSION_TOKEN")).toBe(true);
    expect(GLOBAL_CUSTOM_KEY_NAMES.has("OPENAI_API_KEY")).toBe(false);
  });
});
