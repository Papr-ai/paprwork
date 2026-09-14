import { describe, expect, it, beforeEach } from "vitest";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import {
  chatHasLiveStreamBlockingHistory,
  ensureStreamingAssistantMessageRow,
  type StreamingRefs,
} from "../../lib/agentStreamRecovery";

function makeRefs(messageId: string, chatId: string): StreamingRefs {
  const streamingMessageIdRef = {
    current: new Map([[chatId, messageId]]),
  };
  const streamingContentRef = {
    current: new Map([[chatId, "Hello from stream"]]),
  };
  const streamingReasoningRef = { current: new Map<string, string>() };
  const toolCallsMapRef = { current: new Map<string, Map<string, never>>() };
  const sequenceRef = {
    current: new Map([
      [
        chatId,
        [
          {
            type: "tool" as const,
            data: { name: "bash", status: "success" },
          },
        ],
      ],
    ]),
  };
  const currentTextSegmentRef = { current: new Map<string, string>() };
  return {
    streamingMessageIdRef,
    streamingContentRef,
    streamingReasoningRef,
    toolCallsMapRef,
    sequenceRef,
    currentTextSegmentRef,
  };
}

describe("ensureStreamingAssistantMessageRow", () => {
  const chatId = "chat-1";
  const messageId = "msg-9fdf4d0a-b00a-4acc-8a47-581a1ccda733";

  beforeEach(() => {
    useChatStore.setState({
      chats: [],
      chatStates: new Map([
        [
          chatId,
          {
            ...defaultChatState,
            isSending: true,
            messages: [
              { id: "u1", role: "user", content: "test" },
            ],
          },
        ],
      ]),
      isLoading: false,
      error: null,
    });
  });

  it("recreates a missing assistant row from streaming refs", () => {
    const refs = makeRefs(messageId, chatId);
    ensureStreamingAssistantMessageRow(chatId, messageId, refs);

    const messages =
      useChatStore.getState().chatStates.get(chatId)?.messages ?? [];
    const row = messages.find((m) => m.id === messageId);
    expect(row).toBeDefined();
    expect(row?.isStreaming).toBe(true);
    expect(row?.streamingContent).toBe("Hello from stream");
    expect(row?.sequence).toHaveLength(1);
    expect(useChatStore.getState().streamingState.get(chatId)?.messageId).toBe(
      messageId,
    );
  });

  it("blocks history reload while isSending even without isStreaming row", () => {
    useChatStore.setState((state) => {
      const next = new Map(state.chatStates);
      const chat = next.get(chatId);
      if (!chat) return state;
      next.set(chatId, { ...chat, isSending: true, isStreaming: false });
      return { chatStates: next };
    });

    expect(chatHasLiveStreamBlockingHistory(chatId)).toBe(true);
  });
});
