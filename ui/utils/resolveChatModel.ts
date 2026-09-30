/**
 * Which model should a chat open on?
 *
 * The old rule was "whatever was picked last, anywhere", which is why opening
 * an Opus chat could show — and then actually run — Fable. Precedence now
 * starts from the chat itself and only reaches for a global value when the chat
 * has nothing of its own to go on.
 */

export interface ChatModelCandidates {
  /** Explicit selection made for this chat. */
  perChatModelId?: string;
  /** Model that answered most recently *in this chat* (from persisted history). */
  historyModelId?: string;
  /** Last model picked anywhere. Only meaningful for a chat with no history. */
  newChatDefaultModelId?: string;
  /**
   * Whether this chat already holds a conversation. When true, a global default
   * is never used: an existing chat must not inherit another chat's model.
   */
  hasHistory: boolean;
}

/**
 * Returns the model id to open with, or undefined to fall back to the app's
 * ordinary defaults. The returned id is raw — callers still migrate retired ids
 * and check availability, since a chat may name a model the user can no longer
 * reach.
 */
export function resolveChatModelId(
  candidates: ChatModelCandidates,
): string | undefined {
  if (candidates.perChatModelId) {
    return candidates.perChatModelId;
  }

  // The chat's own history is the truthful record of what it was running on,
  // and it survives restarts and cleared local storage.
  if (candidates.historyModelId) {
    return candidates.historyModelId;
  }

  if (!candidates.hasHistory && candidates.newChatDefaultModelId) {
    return candidates.newChatDefaultModelId;
  }

  return undefined;
}

/** Model that most recently answered in this chat, if any assistant turn did. */
export function findHistoryModelId(
  messages: ReadonlyArray<{ role: string; model?: string }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.model) {
      return message.model;
    }
  }
  return undefined;
}
