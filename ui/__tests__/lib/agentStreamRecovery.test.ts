import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/chat";
import { useChatStore } from "../../stores/chatStore";
import {
  finalizeStreamingMessages,
  interruptedTurnNeedsContinue,
  lastUserTurnNeedsContinue,
  mergeHistoryWithLocal,
  priorUserTurnSettledForQueue,
  recordAutoContinueAttempt,
  resetAutoContinueAttempts,
  getAutoContinueBlockReason,
  resetPostReconnectStreamRecoveryForTests,
  shouldAutoContinueInterruptedTurn,
  shouldAutoRetryStreamRecoveryAfterReconnect,
  markPostReconnectStreamRecoveryAttempted,
  shouldDrainMessageQueue,
  shouldIgnoreDuplicateDoneChunk,
  isStreamDoneChunkWithChatId,
  resolveChatIdForStreamRequest,
  trackActiveStream,
  untrackActiveStream,
  serverHasCompletedAssistantForStreamingTurn,
  shouldResumeWithFreshGatewayStream,
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

  it("clears interrupted flag when server row for the same id is settled", () => {
    const local: ChatMessage[] = [
      { id: "u1", role: "user", content: "Run the job" },
      {
        id: "msg-server",
        role: "assistant",
        content: "Done running the job",
        interrupted: true,
        toolCalls: [
          { id: "t1", toolName: "run_job", args: {}, status: "success" },
          { id: "t2", toolName: "bash", args: {}, status: "success" },
        ],
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

    expect(merged[1]?.id).toBe("msg-server");
    expect(merged[1]?.interrupted).toBeUndefined();
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

  it("does not reorder paginated history when duplicate assistant text appears twice", () => {
    const shared = "OK";
    const local: ChatMessage[] = [
      { id: "m01", role: "user", content: "first" },
      { id: "old-a", role: "assistant", content: shared },
      ...Array.from({ length: 47 }, (_, i) => ({
        id: `m${String(i + 2).padStart(2, "0")}`,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `body ${i + 2}`,
      })),
      { id: "m49", role: "assistant", content: shared },
    ];
    const serverWindow = local.slice(-30).map((m) => ({ ...m }));

    expect(mergeHistoryWithLocal(local, serverWindow).map((m) => m.id)).toEqual(
      local.map((m) => m.id),
    );
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

describe("isStreamDoneChunkWithChatId", () => {
  it("returns true when done chunk includes chatId", () => {
    expect(
      isStreamDoneChunkWithChatId({
        type: "done",
        chatId: "chat-1",
        payload: {},
      }),
    ).toBe(true);
  });

  it("returns false when done chunk is missing chatId", () => {
    expect(isStreamDoneChunkWithChatId({ type: "done", payload: {} })).toBe(
      false,
    );
  });
});

describe("resolveChatIdForStreamRequest", () => {
  it("maps requestId back to the active chat", () => {
    trackActiveStream("chat-abc", "req-123");
    expect(resolveChatIdForStreamRequest("req-123")).toBe("chat-abc");
    untrackActiveStream("chat-abc");
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

describe("priorUserTurnSettledForQueue", () => {
  it("returns false when the last user turn has no assistant yet", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "First question" },
    ];
    expect(priorUserTurnSettledForQueue(messages)).toBe(false);
  });

  it("returns true when the last user turn has a completed assistant", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "First question" },
      { id: "a1", role: "assistant", content: "Answer" },
    ];
    expect(priorUserTurnSettledForQueue(messages)).toBe(true);
  });

  it("returns true when the prior assistant was explicitly interrupted", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "First question" },
      {
        id: "a1",
        role: "assistant",
        content: "Partial",
        interrupted: true,
      },
    ];
    expect(priorUserTurnSettledForQueue(messages)).toBe(true);
  });

  it("returns false when another user message already sits after the last user turn", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "First question" },
      { id: "u2", role: "user", content: "Second question" },
    ];
    expect(priorUserTurnSettledForQueue(messages)).toBe(false);
  });
});

describe("shouldDrainMessageQueue", () => {
  it("returns false while the agent is still sending", () => {
    expect(
      shouldDrainMessageQueue({
        chatId: "chat-1",
        messages: [
          { id: "u1", role: "user", content: "Hi" },
          { id: "a1", role: "assistant", content: "Hello" },
        ],
        isSending: true,
        isWaitingForAgentSlot: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        queueTransitionInFlight: false,
      }),
    ).toBe(false);
  });

  it("returns true when the prior turn settled and nothing is in flight", () => {
    expect(
      shouldDrainMessageQueue({
        chatId: "chat-1",
        messages: [
          { id: "u1", role: "user", content: "Hi" },
          { id: "a1", role: "assistant", content: "Hello" },
        ],
        isSending: false,
        isWaitingForAgentSlot: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        queueTransitionInFlight: false,
      }),
    ).toBe(true);
  });

  it("returns false while the assistant row is finishing wrap-up work", () => {
    const chatId = "chat-finishing-wrap";
    useChatStore
      .getState()
      .addMessage({ id: "seed", role: "user", content: "seed" }, chatId);
    useChatStore.getState().setFinishingWork(chatId, true);
    try {
      expect(
        shouldDrainMessageQueue({
          chatId,
          messages: [
            { id: "u1", role: "user", content: "Hi" },
            { id: "a1", role: "assistant", content: "Hello" },
          ],
          isSending: false,
          isWaitingForAgentSlot: false,
          connectionPaused: false,
          needsStreamRecovery: false,
          queueTransitionInFlight: false,
        }),
      ).toBe(false);
    } finally {
      useChatStore.getState().setFinishingWork(chatId, false);
    }
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

  it("returns true when history reload flagged the last assistant interrupted", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
      {
        id: "a1",
        role: "assistant",
        content: "Partial work saved to DB",
        interrupted: true,
      },
    ];

    expect(
      interruptedTurnNeedsContinue(messages, undefined, false),
    ).toBe(true);
  });

  it("returns false when the user stopped the interrupted turn", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build the dashboard" },
      {
        id: "a1",
        role: "assistant",
        content: "Partial",
        interrupted: true,
        sequence: [
          {
            type: "tool",
            data: { toolName: "bash", status: "stopped", error: "Stopped by user" },
          },
        ],
      },
    ];

    expect(
      interruptedTurnNeedsContinue(messages, undefined, false),
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

describe("autoContinueInterruptedTurn helpers", () => {
  const interruptedAssistant: ChatMessage = {
    id: "a1",
    role: "assistant",
    content: "Partial",
    interrupted: true,
    sequence: [
      { type: "tool", data: { toolName: "bash", status: "success" } },
    ],
  };

  beforeEach(() => {
    resetAutoContinueAttempts("chat-1");
  });

  it("allows auto-continue when the last assistant turn was interrupted", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      interruptedAssistant,
    ];

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe(true);
  });

  it("blocks auto-continue after three attempts for the same user turn", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      interruptedAssistant,
    ];

    recordAutoContinueAttempt("chat-1", messages);
    recordAutoContinueAttempt("chat-1", messages);
    recordAutoContinueAttempt("chat-1", messages);

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe(false);
  });

  it("does not auto-continue user-stopped turns", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      {
        ...interruptedAssistant,
        sequence: [
          {
            type: "tool",
            data: { toolName: "bash", status: "stopped", error: "Stopped by user" },
          },
        ],
      },
    ];

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe(false);
  });

  it("allows auto-continue while needsStreamRecovery is set for interrupted turns", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      interruptedAssistant,
    ];

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: true,
        gatewayReady: true,
      }),
    ).toBe(true);
  });

  it("does not auto-continue a fresh first user message without recovery evidence", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
    ];

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe(false);
    expect(
      getAutoContinueBlockReason({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe("awaitingFirstResponse");
  });

  it("allows auto-continue when provider dropped before any assistant row and recovery is flagged", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
    ];

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: true,
        gatewayReady: true,
      }),
    ).toBe(true);
  });

  it("does not auto-continue when assistant exists but was not marked interrupted", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      {
        id: "a1",
        role: "assistant",
        content: "Partial answer without interrupted flag",
      },
    ];

    expect(
      shouldAutoContinueInterruptedTurn({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe(false);
    expect(
      getAutoContinueBlockReason({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
      }),
    ).toBe("turnComplete");
  });

  it("blocks auto-continue after the user stopped or send-now replaced the turn", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      {
        id: "a1",
        role: "assistant",
        content: "Partial",
        interrupted: true,
      },
    ];
    expect(
      getAutoContinueBlockReason({
        chatId: "chat-1",
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
        lastTurnOutcome: "userStopped",
      }),
    ).toBe("userStopped");
  });
});

describe("post-reconnect stream recovery", () => {
  beforeEach(() => {
    resetPostReconnectStreamRecoveryForTests();
  });

  it("allows one auto retry per chat when needsStreamRecovery is set", () => {
    expect(
      shouldAutoRetryStreamRecoveryAfterReconnect({
        chatId: "c1",
        needsStreamRecovery: true,
        streamRecoveryReason: "connection",
        isSending: false,
      }),
    ).toBe(true);

    markPostReconnectStreamRecoveryAttempted("c1");

    expect(
      shouldAutoRetryStreamRecoveryAfterReconnect({
        chatId: "c1",
        needsStreamRecovery: true,
        streamRecoveryReason: "connection",
        isSending: false,
      }),
    ).toBe(false);
  });

  it("does not auto retry rate-limited recovery", () => {
    expect(
      shouldAutoRetryStreamRecoveryAfterReconnect({
        chatId: "c1",
        needsStreamRecovery: true,
        streamRecoveryReason: "rateLimit",
        isSending: false,
      }),
    ).toBe(false);
  });
});

describe("shouldResumeWithFreshGatewayStream", () => {
  it("requires a fresh stream after rate limit or provider refusal", () => {
    expect(
      shouldResumeWithFreshGatewayStream({ streamRecoveryReason: "rateLimit" }),
    ).toBe(true);
    expect(
      shouldResumeWithFreshGatewayStream({ lastTurnOutcome: "providerRefused" }),
    ).toBe(true);
    expect(
      shouldResumeWithFreshGatewayStream({
        streamRecoveryReason: "connection",
      }),
    ).toBe(false);
  });
});

describe("mergeHistoryWithLocal — saved messages outside the window (stuck queue)", () => {
  // Real ids are msg-<uuid>; optimistic sends are msg-user-<ms>.
  const oldContinue = "msg-cb366112-daa2-49c5-9e92-658b3a1a01c0";
  const a1 = "msg-8abcbcd7-78e9-4ece-af4a-3df8602ca34b";
  const u2 = "msg-3c6504e4-8a93-4039-b838-86fd005901a0";
  const a2 = "msg-265851e4-ac7f-440d-82f7-d2ea2abe5a50";

  it("never plants an older saved user message below the latest reply", () => {
    // "continue" was typed while a1 streamed: locally it sits after a1, but by
    // timestamp it is older — so the newest-N window starts at a1 without it.
    const local: ChatMessage[] = [
      { id: a1, role: "assistant", content: "This changes the picture" },
      { id: oldContinue, role: "user", content: "continue" },
      { id: u2, role: "user", content: "same for 181" },
      { id: a2, role: "assistant", content: "Done" },
    ];
    const server: ChatMessage[] = [
      { id: a1, role: "assistant", content: "This changes the picture" },
      { id: u2, role: "user", content: "same for 181" },
      { id: a2, role: "assistant", content: "Done" },
    ];

    const merged = mergeHistoryWithLocal(local, server);

    expect(merged.at(-1)?.id).toBe(a2);
    expect(merged.findIndex((m) => m.id === oldContinue)).toBeLessThan(
      merged.findIndex((m) => m.id === a2),
    );
    // …so the queue can drain: the last user turn has its reply.
    expect(priorUserTurnSettledForQueue(merged)).toBe(true);
  });

  it("heals a store where the old message already sits at the tail", () => {
    const local: ChatMessage[] = [
      { id: u2, role: "user", content: "same for 181" },
      { id: a2, role: "assistant", content: "Done" },
      { id: oldContinue, role: "user", content: "continue" },
    ];
    const server: ChatMessage[] = [
      { id: u2, role: "user", content: "same for 181" },
      { id: a2, role: "assistant", content: "Done" },
    ];
    expect(priorUserTurnSettledForQueue(local)).toBe(false);

    const merged = mergeHistoryWithLocal(local, server);

    expect(merged.at(-1)?.id).toBe(a2);
    expect(priorUserTurnSettledForQueue(merged)).toBe(true);
  });

  it("still keeps an unsent optimistic message at the end", () => {
    const local: ChatMessage[] = [
      { id: u2, role: "user", content: "same for 181" },
      { id: a2, role: "assistant", content: "Done" },
      { id: "msg-user-1790880085911", role: "user", content: "same for 189" },
    ];
    const server: ChatMessage[] = [
      { id: u2, role: "user", content: "same for 181" },
      { id: a2, role: "assistant", content: "Done" },
    ];

    expect(mergeHistoryWithLocal(local, server).at(-1)?.id).toBe(
      "msg-user-1790880085911",
    );
  });

  it("does not re-pin a send that never saved below newer turns", () => {
    // "video" was sent but never reached the server. The user's next message
    // did save and got a reply. Every reload used to append "video" after
    // that reply, so an old message looked like the newest one each send.
    const stale = "msg-user-1791560900000";
    const next = "msg-user-1791561000000";
    const u3 = "msg-7d1f0a52-3b8e-4c5a-9e0f-1a2b3c4d5e6f";
    const a3 = "msg-0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b";
    const local: ChatMessage[] = [
      { id: u2, role: "user", content: "when I try to login" },
      { id: a2, role: "assistant", content: "Did Chrome reach You're connected?" },
      { id: stale, role: "user", content: "can u make sure the video is in" },
      { id: next, role: "user", content: "new question" },
    ];
    const server: ChatMessage[] = [
      { id: u2, role: "user", content: "when I try to login" },
      { id: a2, role: "assistant", content: "Did Chrome reach You're connected?" },
      { id: u3, role: "user", content: "new question" },
      { id: a3, role: "assistant", content: "Answer" },
    ];

    const merged = mergeHistoryWithLocal(local, server);

    expect(merged.map((m) => m.id)).toEqual([u2, a2, stale, u3, a3]);
    expect(merged[merged.length - 1]?.id).toBe(a3);
    expect(priorUserTurnSettledForQueue(merged)).toBe(true);

    // And it stays put on the next reload instead of drifting to the tail.
    expect(mergeHistoryWithLocal(merged, server).map((m) => m.id)).toEqual([
      u2, a2, stale, u3, a3,
    ]);
  });
});

