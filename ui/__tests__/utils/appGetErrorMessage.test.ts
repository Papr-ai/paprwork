import { describe, expect, it } from "vitest";
import {
  classifyAppGetFailure,
  resolveAppGetUserMessage,
} from "../../utils/appGetErrorMessage";

describe("appGetErrorMessage", () => {
  it("treats gateway timeouts as busy", () => {
    expect(classifyAppGetFailure("Request timeout")).toBe("gateway_busy");
    expect(resolveAppGetUserMessage("Request timeout")).toMatch(/gateway is starting/i);
  });

  it("treats app not found as workspace mismatch", () => {
    expect(classifyAppGetFailure("App not found")).toBe("not_found");
  });
});
