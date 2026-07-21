import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/chat";
import {
  finalizeStreamingMessages,
  interruptedTurnNeedsContinue,
  lastUserTurnNeedsContinue,
  mergeHistoryWithLocal,
  serverHasCompletedAssistantForStreamingTurn,
} from "../../lib/agentStreamRecovery";

describe("serverHasCompletedAssistantForStreamingTurn", () => {
  it("returns false when only a previous-turn assistant exists on server", () => {
    const local: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Old answer" },
      { id: "u2", role: "user", content: "yes" },
      { id: "stream", role: "assistant", content: "", isStreaming: true },
    ];
    const server: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Old answer" },
      { id: "u2", role: "user", content: "yes" },
    ];

    expect(
      serverHasCompletedAssistantForStreamingTurn(local, server, "stream"),
    ).toBe(false);
  });

  it("returns true when server has completed assistant for current user turn", () => {
    const local: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Old answer" },
      { id: "u2", role: "user", content: "yes" },
      { id: "stream", role: "assistant", content: "", isStreaming: true },
    ];
    const server: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Old answer" },
      { id: "u2", role: "user", content: "yes" },
      { id: "a2", role: "assistant", content: "Done" },
    ];

    expect(
      serverHasCompletedAssistantForStreamingTurn(local, server, "stream"),
    ).toBe(true);
  });
});

describe("mergeHistoryWithLocal", () => {
  it("preserves in-progress streaming assistant when server only has older turns", () => {
    const local: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Old answer" },
      { id: "u2", role: "user", content: "yes" },
      { id: "stream", role: "assistant", content: "Working...", isStreaming: true },
    ];
    const server: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "Old answer" },
      { id: "u2", role: "user", content: "yes" },
    ];

    const merged = mergeHistoryWithLocal(local, server, "stream");

    expect(merged.some((m) => m.id === "stream")).toBe(true);
    expect(merged.filter((m) => m.role === "user" && m.content === "yes")).toHaveLength(1);
  });

  it("replaces streaming placeholder when server has completed response for same turn", () => {
    const local: ChatMessage[] = [
      { id: "u2", role: "user", content: "yes" },
      { id: "stream", role: "assistant", content: "", isStreaming: true },
    ];
    const server: ChatMessage[] = [
      { id: "u2", role: "user", content: "yes" },
      { id: "a2", role: "assistant", content: "Final answer" },
    ];

    const merged = mergeHistoryWithLocal(local, server, "stream");

    expect(merged.some((m) => m.id === "stream")).toBe(false);
    expect(merged.some((m) => m.id === "a2")).toBe(true);
  });
});

describe("lastUserTurnNeedsContinue", () => {
  it("returns true when last user turn has no assistant response", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
    ];
    expect(lastUserTurnNeedsContinue(messages)).toBe(true);
  });

  it("returns false when assistant completed the last user turn", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
      { id: "a1", role: "assistant", content: "Done" },
    ];
    expect(lastUserTurnNeedsContinue(messages)).toBe(false);
  });

  it("returns true when only an empty finalized assistant exists", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
      { id: "a1", role: "assistant", content: "" },
    ];
    expect(lastUserTurnNeedsContinue(messages)).toBe(true);
  });
});

describe("interruptedTurnNeedsContinue", () => {
  it("returns true when partial assistant was interrupted with content", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
      {
        id: "stream",
        role: "assistant",
        content: "Partial work",
        isStreaming: false,
      },
    ];

    expect(
      interruptedTurnNeedsContinue(messages, "stream", false),
    ).toBe(true);
  });

  it("returns false when server completed the interrupted turn", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
      { id: "a1", role: "assistant", content: "Done" },
    ];

    expect(
      interruptedTurnNeedsContinue(messages, "stream", true),
    ).toBe(false);
  });
});

describe("finalizeStreamingMessages", () => {
  it("clears isStreaming and preserves streaming content", () => {
    const messages: ChatMessage[] = [
      {
        id: "stream",
        role: "assistant",
        content: "",
        isStreaming: true,
        streamingContent: "Partial work",
      },
    ];
    const finalized = finalizeStreamingMessages(messages);
    expect(finalized[0]?.isStreaming).toBe(false);
    expect(finalized[0]?.content).toBe("Partial work");
  });
});
