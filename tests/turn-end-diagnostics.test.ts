import { describe, expect, test } from "vitest";
import {
  explainPostStreamWrapUp,
} from "../src/gateway/services/agent/turnEndDiagnostics.js";

describe("turnEndDiagnostics", () => {
  test("requests post-stream wrap-up when ending on tools without text", () => {
    const result = explainPostStreamWrapUp({
      sequence: [
        { type: "tool", data: { name: "bash", status: "success" } },
      ],
      toolCallCount: 1,
      aborted: false,
      isWrapUpContinuation: false,
    });
    expect(result).toEqual({ requested: true });
  });

  test("skips wrap-up when trailing text follows tools", () => {
    const result = explainPostStreamWrapUp({
      sequence: [
        { type: "tool", data: { name: "edit_file", status: "success" } },
        { type: "text", data: "Done for now." },
      ],
      toolCallCount: 1,
      aborted: false,
      isWrapUpContinuation: false,
    });
    expect(result).toEqual({
      requested: false,
      skipReason: "trailing_text_after_tools",
    });
  });

  test("skips wrap-up when turn was aborted", () => {
    const result = explainPostStreamWrapUp({
      sequence: [{ type: "tool", data: { name: "bash", status: "success" } }],
      toolCallCount: 1,
      aborted: true,
      isWrapUpContinuation: false,
    });
    expect(result).toEqual({ requested: false, skipReason: "aborted" });
  });
});
