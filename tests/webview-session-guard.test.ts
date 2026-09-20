import { describe, expect, it } from "vitest";
import { shouldBlockBrowserToolsForWebviewPreview } from "../src/core/tools/webviewSessionGuard.js";

describe("shouldBlockBrowserToolsForWebviewPreview", () => {
  it("blocks when a headless mini-app webview session is active", () => {
    expect(
      shouldBlockBrowserToolsForWebviewPreview(true, {
        platformBrowserActive: false,
      }),
    ).toBe(true);
  });

  it("does not block when no webview sessions are open", () => {
    expect(shouldBlockBrowserToolsForWebviewPreview(false)).toBe(false);
  });

  it("does not block when Papr Chrome platform session is active", () => {
    expect(
      shouldBlockBrowserToolsForWebviewPreview(true, {
        platformBrowserActive: true,
      }),
    ).toBe(false);
  });
});
