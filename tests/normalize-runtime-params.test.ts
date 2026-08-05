import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeParamKey,
  normalizeRuntimeParams,
  runtimeParamsForJobEnv,
} from "../src/gateway/utils/normalizeRuntimeParams.js";

describe("normalizeRuntimeParams", () => {
  it("maps snake_case app params to UPPER_SNAKE env keys", () => {
    expect(normalizeRuntimeParamKey("audit_id")).toBe("AUDIT_ID");
    expect(normalizeRuntimeParamKey("company_name")).toBe("COMPANY_NAME");
    expect(normalizeRuntimeParamKey("WEBSITE_URL")).toBe("WEBSITE_URL");
    expect(normalizeRuntimeParamKey("prompt")).toBe("prompt");
  });

  it("normalizes runtime param records", () => {
    expect(
      normalizeRuntimeParams({
        audit_id: "c3f6c3e1",
        company_name: "Papr",
        prompt: "Run audit",
      }),
    ).toEqual({
      AUDIT_ID: "c3f6c3e1",
      COMPANY_NAME: "Papr",
      prompt: "Run audit",
    });
  });

  it("excludes prompt from job env", () => {
    expect(
      runtimeParamsForJobEnv({
        audit_id: "abc",
        prompt: "ignored",
      }),
    ).toEqual({ AUDIT_ID: "abc" });
  });
});
