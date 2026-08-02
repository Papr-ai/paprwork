import { describe, expect, test } from "vitest";
import {
  mergeWrapUpTextIntoState,
  shouldRequestWrapUpSummary,
} from "../src/gateway/services/agent/wrapUpContinuation.js";

describe("wrapUpContinuation", () => {
  test("shouldRequestWrapUpSummary when turn ends on tools only", () => {
    expect(
      shouldRequestWrapUpSummary({
        sequence: [
          { type: "text", data: "Starting work" },
          { type: "tool", data: { name: "edit_app_file" } },
        ],
        toolCallCount: 1,
        aborted: false,
        isWrapUpContinuation: false,
      }),
    ).toBe(true);
  });

  test("shouldRequestWrapUpSummary false when trailing text exists", () => {
    expect(
      shouldRequestWrapUpSummary({
        sequence: [
          { type: "tool", data: { name: "edit_app_file" } },
          { type: "text", data: "All done — here is the summary." },
        ],
        toolCallCount: 1,
        aborted: false,
        isWrapUpContinuation: false,
      }),
    ).toBe(false);
  });

  test("mergeWrapUpTextIntoState appends final text segment", () => {
    const merged = mergeWrapUpTextIntoState(
      {
        assistantText: "Mid-turn narration",
        thinkingText: "",
        toolCalls: [],
        toolResults: [],
        sequence: [
          { type: "text", data: "Mid-turn narration" },
          { type: "tool", data: { name: "bash" } },
        ],
      },
      "Final summary for the user.",
    );

    expect(merged.assistantText).toContain("Final summary for the user.");
    expect(merged.sequence.at(-1)).toEqual({
      type: "text",
      data: "Final summary for the user.",
    });
  });
});
