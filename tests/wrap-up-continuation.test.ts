import { describe, expect, test } from "vitest";
import {
  applyForcedTextOnlyWrapUpStep,
  mergeWrapUpTextIntoState,
  shouldRequestWrapUpSummary,
  WRAP_UP_AFTER_TOOLS_NO_TEXT,
} from "../src/gateway/services/agent/wrapUpContinuation.js";

describe("wrapUpContinuation", () => {
  test("shouldRequestWrapUpSummary when stream done and sequence ends on tools only", () => {
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

  test("shouldRequestWrapUpSummary after multi-batch turn when stream ends on tools", () => {
    expect(
      shouldRequestWrapUpSummary({
        sequence: [
          { type: "text", data: "Reading files first" },
          { type: "tool", data: { name: "read_app_file" } },
          { type: "text", data: "Migration applied. Updating store next." },
          { type: "tool", data: { name: "edit_app_file" } },
        ],
        toolCallCount: 2,
        aborted: false,
        isWrapUpContinuation: false,
      }),
    ).toBe(true);
  });

  test("applyForcedTextOnlyWrapUpStep clears tools", () => {
    const context = {
      messages: [] as unknown[],
      tools: [{ name: "bash" }],
    };
    applyForcedTextOnlyWrapUpStep(context, WRAP_UP_AFTER_TOOLS_NO_TEXT);
    expect(context.tools).toEqual([]);
    expect(context.messages).toHaveLength(1);
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

  test("shouldRequestWrapUpSummary false when interrupted tools remain", () => {
    expect(
      shouldRequestWrapUpSummary({
        sequence: [
          { type: "tool", data: { name: "edit_app_file", status: "success" } },
          { type: "tool", data: { name: "edit_app_file", status: "interrupted" } },
        ],
        toolCallCount: 2,
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
