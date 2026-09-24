import { describe, expect, it } from "vitest";
import {
  readSourceAppIdFromApproveBody,
} from "../src/gateway/services/contributeApproveFollowUp.js";

describe("readSourceAppIdFromApproveBody", () => {
  it("reads camelCase sourceAppId", () => {
    expect(
      readSourceAppIdFromApproveBody({ sourceAppId: "  abc-123  " }),
    ).toBe("abc-123");
  });

  it("reads snake_case source_app_id", () => {
    expect(
      readSourceAppIdFromApproveBody({ source_app_id: "def-456" }),
    ).toBe("def-456");
  });

  it("returns undefined when missing", () => {
    expect(readSourceAppIdFromApproveBody({})).toBeUndefined();
  });
});
