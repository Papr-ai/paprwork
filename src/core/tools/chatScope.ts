import { getCurrentChatId } from "./context.js";

/** Literal passed by the agent to scope tools to the active chat session. */
export const CURRENT_CHAT_SCOPE = "current_chat" as const;

/**
 * Resolve chatId param: explicit UUID, or "current_chat" → active session id.
 */
export function resolveConversationId(
  chatId: string | undefined,
): string | undefined {
  if (!chatId) {
    return undefined;
  }
  if (chatId === CURRENT_CHAT_SCOPE) {
    return getCurrentChatId() ?? undefined;
  }
  return chatId;
}

/**
 * Like resolveConversationId but throws when "current_chat" has no active session.
 */
export function requireConversationId(chatId: string | undefined): string {
  if (!chatId) {
    throw new Error("chatId is required.");
  }
  const resolved = resolveConversationId(chatId);
  if (!resolved) {
    throw new Error(
      `chatId "${CURRENT_CHAT_SCOPE}" requires an active chat session. ` +
        "Pass an explicit chat UUID instead.",
    );
  }
  return resolved;
}

/**
 * Resolve which chat(s) to search for get_full_tool_result.
 * Returns null when caller should load all chats (searchIn === "all_chats").
 */
export function resolveToolResultChatScope(args: {
  chatId?: string;
  searchIn?: "current_chat" | "all_chats";
}):
  | { mode: "single"; chatId: string }
  | { mode: "all" }
  | { error: string } {
  if (args.chatId) {
    if (args.chatId === CURRENT_CHAT_SCOPE) {
      const current = getCurrentChatId();
      if (!current) {
        return {
          error:
            `chatId "${CURRENT_CHAT_SCOPE}" requires an active chat session. ` +
            "Pass an explicit chat UUID or use searchIn: 'all_chats'.",
        };
      }
      return { mode: "single", chatId: current };
    }
    return { mode: "single", chatId: args.chatId };
  }

  if (args.searchIn === "all_chats") {
    return { mode: "all" };
  }

  const current = getCurrentChatId();
  if (!current) {
    return {
      error:
        "No active chat context. Pass chatId, use chatId: 'current_chat' in an active chat, " +
        "or set searchIn: 'all_chats'.",
    };
  }
  return { mode: "single", chatId: current };
}
