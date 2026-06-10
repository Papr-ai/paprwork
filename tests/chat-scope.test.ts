import { describe, expect, test } from "vitest";
import {
  CURRENT_CHAT_SCOPE,
  resolveConversationId,
  resolveToolResultChatScope,
} from "../src/core/tools/chatScope.js";
import { runWithToolContext } from "../src/core/tools/context.js";

describe("chatScope", () => {
  test("resolveConversationId passes through explicit chat UUID", () => {
    expect(resolveConversationId("853a0658-d5d6-4476-b26f-e34897bed840")).toBe(
      "853a0658-d5d6-4476-b26f-e34897bed840",
    );
  });

  test("resolveConversationId maps current_chat to active session", () => {
    const resolved = runWithToolContext("chat-active-123", () =>
      resolveConversationId(CURRENT_CHAT_SCOPE),
    );
    expect(resolved).toBe("chat-active-123");
  });

  test("resolveConversationId returns undefined for current_chat without context", () => {
    expect(resolveConversationId(CURRENT_CHAT_SCOPE)).toBeUndefined();
  });

  test("resolveToolResultChatScope defaults to active chat", () => {
    const scope = runWithToolContext("chat-active-123", () =>
      resolveToolResultChatScope({ searchIn: "current_chat" }),
    );
    expect(scope).toEqual({ mode: "single", chatId: "chat-active-123" });
  });

  test("resolveToolResultChatScope errors without active chat", () => {
    const scope = resolveToolResultChatScope({ searchIn: "current_chat" });
    expect(scope).toHaveProperty("error");
  });

  test("resolveToolResultChatScope supports all_chats mode", () => {
    const scope = resolveToolResultChatScope({ searchIn: "all_chats" });
    expect(scope).toEqual({ mode: "all" });
  });
});
