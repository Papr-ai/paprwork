/**
 * Test: PAPR Memory Metadata Enhancement
 *
 * Verifies that chat messages include rich metadata when synced to PAPR Memory
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { PaprMemoryProvider } from "../src/gateway/services/storage/PaprMemoryProvider";
import type { StoredMessage } from "../src/gateway/services/storage/IStorageProvider";

vi.mock("../src/gateway/utils/paprUserId.js", () => ({
  getPaprUserId: vi.fn(() => "WkPutXGdqg"),
  invalidatePaprUserIdCache: vi.fn(),
  paprUserScope: vi.fn(() => ({ external_user_id: "WkPutXGdqg" })),
}));

type MessageStoreCall = {
  content: string | Array<Record<string, unknown>>;
  role: string;
  sessionId: string;
  process_messages: boolean;
  user_id?: string;
  external_user_id?: string;
  metadata: {
    conversationId: string;
    createdAt: string;
    role: string;
    customMetadata: Record<string, string | number | boolean | Array<string>>;
  };
};

vi.mock("../src/gateway/utils/memoryScopeResolver.js", () => ({
  buildPaprMemoryWriteScope: vi.fn().mockResolvedValue({
    external_user_id: "WkPutXGdqg",
    namespace_id: undefined,
    policy: undefined,
  }),
}));

// Mock @papr/memory SDK — attach error classes on default export (matches real SDK)
vi.mock("@papr/memory", () => {
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {}
  class PermissionDeniedError extends Error {}
  class NotFoundError extends Error {}

  const MockPapr = vi.fn().mockImplementation(() => ({
    messages: {
      store: vi.fn().mockResolvedValue({ objectId: "test-obj-123" }),
      sessions: {
        retrieveHistory: vi.fn().mockResolvedValue({
          messages: [],
          total_count: 0,
        }),
        compress: vi.fn().mockResolvedValue({
          summaries: {
            short_term: "Short summary",
            medium_term: "Medium summary",
            long_term: "Long summary",
            topics: ["topic1", "topic2"],
            last_updated: new Date().toISOString(),
          },
        }),
      },
    },
  }));

  MockPapr.AuthenticationError = AuthenticationError;
  MockPapr.RateLimitError = RateLimitError;
  MockPapr.PermissionDeniedError = PermissionDeniedError;
  MockPapr.NotFoundError = NotFoundError;

  return {
    default: MockPapr,
    AuthenticationError,
    RateLimitError,
    PermissionDeniedError,
    NotFoundError,
  };
});

function getStoreCall(mockStore: Mock): MessageStoreCall {
  return mockStore.mock.calls[0][0] as MessageStoreCall;
}

describe("PAPR Memory Metadata Enhancement", () => {
  let provider: PaprMemoryProvider;
  let mockStore: Mock;

  beforeEach(async () => {
    const Papr = (await import("@papr/memory")).default;
    provider = new PaprMemoryProvider({
      apiKey: "test-key",
    });

    mockStore = (provider as unknown as { client: { messages: { store: Mock } } })
      .client.messages.store;
    mockStore.mockClear();
  });

  it("should send top-level external_user_id when papr user is available", async () => {
    const message: StoredMessage = {
      id: "msg-user-id",
      chat_id: "chat-123",
      role: "user",
      content: "Hello world",
      timestamp: new Date().toISOString(),
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        external_user_id: "WkPutXGdqg",
      }),
    );
  });

  it("should include basic metadata for simple messages", async () => {
    const message: StoredMessage = {
      id: "msg-1",
      chat_id: "chat-123",
      role: "user",
      content: "Hello world",
      timestamp: new Date().toISOString(),
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.content).toBe("Hello world");
    expect(call.role).toBe("user");
    expect(call.sessionId).toBe("chat-123");
    expect(call.process_messages).toBe(true);
    expect(call.metadata).toMatchObject({
      conversationId: "chat-123",
      role: "user",
    });
    expect(call.metadata.customMetadata).toMatchObject({
      sourceAgentId: "main-agent",
      sourceAgentName: "Paprwork Assistant",
      model: "unknown",
    });
  });

  it("should include model metadata", async () => {
    const message: StoredMessage = {
      id: "msg-2",
      chat_id: "chat-123",
      role: "assistant",
      content: "Response text",
      timestamp: new Date().toISOString(),
      model: "claude-sonnet-4.5",
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.metadata.customMetadata.model).toBe("claude-sonnet-4.5");
  });

  it("should serialize tool calls as structured content blocks", async () => {
    const message: StoredMessage = {
      id: "msg-3",
      chat_id: "chat-123",
      role: "assistant",
      content: "Created file",
      timestamp: new Date().toISOString(),
      model: "gpt-5.4",
      toolCalls: [
        {
          id: "call-1",
          name: "bash",
          args: { command: "ls -la" },
          result: "file listing",
          status: "success",
        },
        {
          id: "call-2",
          name: "write_file",
          args: { path: "test.txt", content: "Hello" },
          result: "File written",
          status: "success",
        },
      ],
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(Array.isArray(call.content)).toBe(true);
    const blocks = call.content as Array<Record<string, unknown>>;
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Created file" }),
        expect.objectContaining({ type: "tool_use", id: "call-1", name: "bash" }),
        expect.objectContaining({ type: "tool_result", tool_use_id: "call-1" }),
        expect.objectContaining({ type: "tool_use", id: "call-2", name: "write_file" }),
        expect.objectContaining({ type: "tool_result", tool_use_id: "call-2" }),
      ]),
    );
    expect(call.metadata.customMetadata).toMatchObject({
      toolsUsed: ["bash", "write_file"],
      toolCallsCount: 2,
    });
  });

  it("should include thinking metadata", async () => {
    const thinkingText = "Let me analyze this step by step...".repeat(10);
    const message: StoredMessage = {
      id: "msg-4",
      chat_id: "chat-123",
      role: "assistant",
      content: "Final answer",
      timestamp: new Date().toISOString(),
      model: "claude-opus-4.5",
      thinking: thinkingText,
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.metadata.customMetadata).toMatchObject({
      hasThinking: true,
      thinkingLength: thinkingText.length,
    });
  });

  it("should include token usage metadata", async () => {
    const message: StoredMessage = {
      id: "msg-5",
      chat_id: "chat-123",
      role: "assistant",
      content: "Response with token tracking",
      timestamp: new Date().toISOString(),
      model: "gpt-5.4",
      prompt_tokens: 5000,
      completion_tokens: 1500,
      total_tokens: 6500,
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.metadata.customMetadata).toMatchObject({
      promptTokens: 5000,
      completionTokens: 1500,
      totalTokens: 6500,
    });
  });

  it("should include error metadata", async () => {
    const message: StoredMessage = {
      id: "msg-6",
      chat_id: "chat-123",
      role: "assistant",
      content: "Partial response",
      timestamp: new Date().toISOString(),
      model: "claude-sonnet-4.5",
      error: "API timeout after 30s",
      incomplete: true,
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.metadata.customMetadata).toMatchObject({
      hasError: true,
      incomplete: true,
    });
  });

  it("should allow SubAgent to override source agent", async () => {
    const message: StoredMessage = {
      id: "msg-7",
      chat_id: "chat-123",
      role: "assistant",
      content: "Research findings",
      timestamp: new Date().toISOString(),
      model: "gpt-5-mini",
      source_agent_id: "research-specialist",
      source_agent_name: "Research Specialist",
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.metadata.customMetadata).toMatchObject({
      sourceAgentId: "research-specialist",
      sourceAgentName: "Research Specialist",
    });
  });

  it("should handle message with all metadata fields", async () => {
    const message: StoredMessage = {
      id: "msg-8",
      chat_id: "chat-123",
      role: "assistant",
      content: "Complex response with everything",
      timestamp: new Date().toISOString(),
      model: "claude-opus-4.5",
      thinking: "Deep reasoning process...",
      toolCalls: [{ id: "call-1", name: "bash", args: {}, status: "success" }],
      prompt_tokens: 10000,
      completion_tokens: 5000,
      total_tokens: 15000,
      source_agent_id: "implementation-specialist",
      source_agent_name: "Implementation Specialist",
      sync_status: "sync_pending",
    };

    await provider.saveMessage("chat-123", message);

    const call = getStoreCall(mockStore);
    expect(call.metadata).toMatchObject({
      conversationId: "chat-123",
      role: "assistant",
    });
    expect(call.metadata.customMetadata).toMatchObject({
      sourceAgentId: "implementation-specialist",
      sourceAgentName: "Implementation Specialist",
      model: "claude-opus-4.5",
      toolsUsed: ["bash"],
      toolCallsCount: 1,
      hasThinking: true,
      thinkingLength: "Deep reasoning process...".length,
      promptTokens: 10000,
      completionTokens: 5000,
      totalTokens: 15000,
    });
  });
});
