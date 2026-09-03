import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/chat";
import {
  finalizeStreamingMessages,
  interruptedTurnNeedsContinue,
  lastUserTurnNeedsContinue,
  mergeHistoryWithLocal,
  shouldIgnoreDuplicateDoneChunk,
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

  it("upgrades local assistant shell when server has sequence and toolCalls", () => {
    const local: ChatMessage[] = [
      { id: "u1", role: "user", content: "Run the job" },
      {
        id: "stream-local",
        role: "assistant",
        content: "Done running the job",
        toolCalls: [{ id: "t1", toolName: "run_job", args: {}, status: "success" }],
      },
    ];
    const server: ChatMessage[] = [
      { id: "u1", role: "user", content: "Run the job" },
      {
        id: "msg-server",
        role: "assistant",
        content: "Done running the job",
        sequence: [{ type: "tool", data: { name: "run_job" } }],
        toolCalls: [{ id: "t1", toolName: "run_job", args: {}, status: "success" }],
      },
    ];

    const merged = mergeHistoryWithLocal(local, server);

    expect(merged).toHaveLength(2);
    expect(merged[1]?.id).toBe("msg-server");
    expect(merged[1]?.sequence).toHaveLength(1);
  });

  it("inserts missing server assistant in chronological order, not at end", () => {
    const local: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "First answer" },
      { id: "u1", role: "user", content: "Question one" },
      { id: "u2", role: "user", content: "Question two" },
    ];
    const server: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "First answer" },
      { id: "u1", role: "user", content: "Question one" },
      {
        id: "a2",
        role: "assistant",
        content: "Second answer",
        sequence: [{ type: "text", data: "Second answer" }],
      },
      { id: "u2", role: "user", content: "Question two" },
    ];

    const merged = mergeHistoryWithLocal(local, server);

    expect(merged.map((m) => m.id)).toEqual(["a1", "u1", "a2", "u2"]);
  });

  it("merges persisted attachments from server onto optimistic duplicate user message", () => {
    const local: ChatMessage[] = [
      {
        id: "msg-user-local",
        role: "user",
        content: "Review this PDF",
      },
    ];
    const server: ChatMessage[] = [
      {
        id: "msg-server",
        role: "user",
        content: "Review this PDF",
        attachments: [
          {
            id: "file-1",
            name: "report.pdf",
            kind: "file",
            mimeType: "application/pdf",
            filePath: "/tmp/report.pdf",
          },
        ],
      },
    ];

    const merged = mergeHistoryWithLocal(local, server);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.attachments).toHaveLength(1);
    expect(merged[0]?.attachments?.[0]?.name).toBe("report.pdf");
  });
});

describe("shouldIgnoreDuplicateDoneChunk", () => {
  it("returns false when a new server message follows an older assistant", () => {
    const messages: ChatMessage[] = [
      { id: "a-old", role: "assistant", content: "Previous answer" },
      { id: "u-new", role: "user", content: "Follow up" },
    ];

    expect(
      shouldIgnoreDuplicateDoneChunk({
        finalMessageId: "a-new",
        messages,
        hasActiveStreamingMessageId: false,
        isSending: false,
      }),
    ).toBe(false);
  });

  it("returns true when the same server message is already finalized", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Question" },
      { id: "a1", role: "assistant", content: "Answer" },
    ];

    expect(
      shouldIgnoreDuplicateDoneChunk({
        finalMessageId: "a1",
        messages,
        hasActiveStreamingMessageId: false,
        isSending: false,
      }),
    ).toBe(true);
  });

  it("returns false while a stream is still active", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Question" },
      { id: "a-old", role: "assistant", content: "Old" },
    ];

    expect(
      shouldIgnoreDuplicateDoneChunk({
        finalMessageId: "a-new",
        messages,
        hasActiveStreamingMessageId: true,
        isSending: false,
      }),
    ).toBe(false);
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

  it("flags the abandoned turn as interrupted so it is not shown as finished", () => {
    const messages: ChatMessage[] = [
      {
        id: "stream",
        role: "assistant",
        content: "",
        isStreaming: true,
        streamingContent: "Partial work",
      },
    ];

    expect(finalizeStreamingMessages(messages)[0]?.interrupted).toBe(true);
  });

  it("settles tool calls that never reported back", () => {
    const messages: ChatMessage[] = [
      {
        id: "stream",
        role: "assistant",
        content: "",
        isStreaming: true,
        sequence: [
          { type: "tool", data: { id: "t1", toolName: "bash", status: "calling" } },
          { type: "tool", data: { id: "t2", toolName: "bash", status: "success" } },
        ],
      },
    ];

    const sequence = finalizeStreamingMessages(messages)[0]?.sequence ?? [];

    expect((sequence[0]?.data as { status: string }).status).toBe("interrupted");
    expect((sequence[1]?.data as { status: string }).status).toBe("success");
  });

  it("leaves completed messages untouched", () => {
    const messages: ChatMessage[] = [
      { id: "done", role: "assistant", content: "All finished" },
    ];

    expect(finalizeStreamingMessages(messages)[0]?.interrupted).toBeUndefined();
  });
});
