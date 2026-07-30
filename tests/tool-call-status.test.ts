import { describe, expect, test } from "vitest";
import {
  getToolResultFeedback,
  isFailedToolResult,
  resolveToolCallStatus,
} from "../src/core/utils/interruptedToolResult.js";

describe("isFailedToolResult", () => {
  test("detects string error field", () => {
    expect(
      isFailedToolResult({ error: "Tool input validation failed for create_app" }),
    ).toBe(true);
  });

  test("detects success:false with blocking error", () => {
    expect(isFailedToolResult({ success: false, error: "blocked" })).toBe(true);
  });

  test("detects JSON string results", () => {
    expect(
      isFailedToolResult(
        JSON.stringify({ error: "Tool input validation failed" }),
      ),
    ).toBe(true);
  });

  test("treats successful payloads as not failed", () => {
    expect(isFailedToolResult({ success: true, data: { id: "abc" } })).toBe(
      false,
    );
  });

  test("treats warnings-only as not failed", () => {
    expect(
      isFailedToolResult({
        success: true,
        data: {
          buildCheck: {
            issues: [{ severity: "warning", message: "Long file", file: "app.ts" }],
          },
        },
      }),
    ).toBe(false);
  });
});

describe("resolveToolCallStatus", () => {
  test("marks failed tool results as error even without payload.error", () => {
    expect(
      resolveToolCallStatus({
        result: { error: "Tool input validation failed for create_app" },
      }),
    ).toBe("error");
  });

  test("keeps successful tool results as success", () => {
    expect(
      resolveToolCallStatus({
        result: { success: true, data: { id: "abc" } },
      }),
    ).toBe("success");
  });

  test("marks warnings-only validation as warning", () => {
    expect(
      resolveToolCallStatus({
        result: {
          success: true,
          data: {
            buildCheck: {
              issues: [
                {
                  severity: "warning",
                  file: "base.css",
                  message: "File has 120 lines (20 over the 100 line limit).",
                  rule: "max-lines",
                },
              ],
            },
          },
        },
      }),
    ).toBe("warning");
  });

  test("marks blocking validation errors as error", () => {
    expect(
      resolveToolCallStatus({
        result: {
          success: false,
          error: "BUILD FAILED",
          data: {
            validation: {
              issues: [
                {
                  severity: "error",
                  file: "app.ts",
                  message: "Unexpected token",
                },
              ],
            },
          },
        },
      }),
    ).toBe("error");
  });
});

describe("getToolResultFeedback", () => {
  test("returns truncated error message for failed tools", () => {
    const feedback = getToolResultFeedback({
      status: "error",
      result: {
        success: false,
        error: "⛔ BUILD FAILED — 1 error(s)\n\napp.ts: Unexpected token",
      },
    });
    expect(feedback?.message).toContain("BUILD FAILED");
  });

  test("returns issue summary for warnings", () => {
    const feedback = getToolResultFeedback({
      status: "warning",
      result: {
        success: true,
        data: {
          issues: [
            {
              severity: "warning",
              file: "base.css",
              message: "File has 120 lines (20 over the 100 line limit).",
            },
          ],
        },
      },
    });
    expect(feedback?.message).toContain("base.css");
    expect(feedback?.message).toContain("120 lines");
  });
});
