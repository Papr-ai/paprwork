import { describe, expect, it } from "vitest";
import { isStalePlaywrightContextError } from "../src/gateway/services/platforms/platformPaprChromeSession.js";

describe("isStalePlaywrightContextError", () => {
  it("detects closed browser context errors", () => {
    expect(
      isStalePlaywrightContextError(
        new Error("browserContext.newPage: Target page, context or browser has been closed"),
      ),
    ).toBe(true);
  });

  it("detects websocket disconnect errors", () => {
    expect(isStalePlaywrightContextError(new Error("WebSocket is not open"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isStalePlaywrightContextError(new Error("navigation timeout"))).toBe(false);
  });
});
