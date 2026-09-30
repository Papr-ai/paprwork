import { describe, expect, it } from "vitest";
import {
  collectWebviewSessionPreview,
  hasAppToolPreview,
  normalizeToolResult,
  shouldShowWebviewSessionPreview,
} from "../ui/components/Chat/AppToolPreview";

describe("normalizeToolResult", () => {
  it("stringifies object tool results", () => {
    const normalized = normalizeToolResult({
      success: true,
      data: { screenshot: "data:image/png;base64,abc" },
    });
    expect(normalized).toContain("screenshot");
  });
});

describe("hasAppToolPreview", () => {
  it("delegates webview session tools to the consolidated preview card", () => {
    expect(
      hasAppToolPreview(
        "webview_launch_app",
        { appId: "app-123" },
        { success: true, data: { webviewId: "wv-1" } },
        "success",
      ),
    ).toBe(false);
  });

  it("shows completed webview snapshot when handled outside session tools", () => {
    expect(
      hasAppToolPreview(
        "webview_execute",
        { webviewId: "wv-1" },
        {
          success: true,
          data: { text: "3 rows visible" },
        },
        "success",
      ),
    ).toBe(true);
  });
});

describe("collectWebviewSessionPreview", () => {
  it("keeps preview active while streaming before screenshots arrive", () => {
    const state = collectWebviewSessionPreview(
      [
        {
          toolName: "webview_launch_app",
          args: { appId: "app-123" },
          result: { success: true, data: { webviewId: "wv-1" } },
          status: "success",
        },
        {
          toolName: "page_wait_for",
          args: { target: "mini_app", time: 2 },
          result: { success: true, data: { webviewId: "wv-1" } },
          status: "success",
        },
      ],
      true,
    );

    expect(state?.isActive).toBe(true);
    expect(shouldShowWebviewSessionPreview(state)).toBe(true);
  });

  it("collects screenshots and visible text from snapshot steps", () => {
    const state = collectWebviewSessionPreview(
      [
        {
          toolName: "webview_launch_app",
          args: { appId: "app-123" },
          result: { success: true, data: { webviewId: "wv-1" } },
          status: "success",
        },
        {
          toolName: "webview_snapshot",
          args: { webviewId: "wv-1" },
          result: {
            success: true,
            data: {
              webviewId: "wv-1",
              screenshot: "data:image/png;base64,abc",
              text: "Summary column visible",
            },
          },
          status: "success",
        },
      ],
      false,
    );

    expect(state?.screenshots).toHaveLength(1);
    expect(state?.visibleText).toContain("Summary column");
    expect(state?.isActive).toBe(false);
  });
});
