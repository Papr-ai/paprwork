import { describe, expect, it } from "vitest";
import { assistantMessageHasVisibleContent } from "../../utils/assistantMessageVisibility";
import type { ChatMessage } from "../../stores/chatStore";

describe("assistantMessageHasVisibleContent", () => {
  it("returns false for empty streaming shell", () => {
    const message: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      isStreaming: true,
      streamingContent: "",
      streamingReasoning: "",
      sequence: [],
      toolCalls: [],
    };
    expect(assistantMessageHasVisibleContent(message)).toBe(false);
  });

  it("returns true when streaming reasoning exists", () => {
    const message: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      isStreaming: true,
      streamingReasoning: "Planning next step",
    };
    expect(assistantMessageHasVisibleContent(message)).toBe(true);
  });

  it("returns true when sequence has items", () => {
    const message: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      isStreaming: true,
      sequence: [{ type: "tool", data: { toolName: "bash" } }],
    };
    expect(assistantMessageHasVisibleContent(message)).toBe(true);
  });
});
