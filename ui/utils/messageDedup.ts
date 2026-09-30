import type { ChatMessage } from "../types/chat";

const OPTIMISTIC_USER_ID = /^msg-user-\d+$/;

function attachmentKey(message: ChatMessage): string {
  if (!message.attachments?.length) return "";
  return message.attachments.map((item) => item.id).join(",");
}

/** Stable key for duplicate user sends (optimistic id vs persisted id). */
export function userMessageDedupKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  const content = message.content.trim();
  if (!content) return null;
  return `${content}::${attachmentKey(message)}`;
}

function isOptimisticUserId(id: string): boolean {
  return OPTIMISTIC_USER_ID.test(id);
}

function preferCanonicalUserMessage(
  existing: ChatMessage,
  incoming: ChatMessage,
): ChatMessage {
  const existingOptimistic = isOptimisticUserId(existing.id);
  const incomingOptimistic = isOptimisticUserId(incoming.id);
  if (existingOptimistic && !incomingOptimistic) {
    return { ...incoming, attachments: existing.attachments ?? incoming.attachments };
  }
  if (!existingOptimistic && incomingOptimistic) {
    return existing;
  }
  return existing;
}

/**
 * Drop duplicate user messages that share content but were saved under different ids
 * (client optimistic send vs server persistence, or pagination overlap).
 */
export function dedupeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const keyToIndex = new Map<string, number>();

  for (const message of messages) {
    const key = userMessageDedupKey(message);
    if (!key) {
      result.push(message);
      continue;
    }

    const existingIndex = keyToIndex.get(key);
    if (existingIndex === undefined) {
      keyToIndex.set(key, result.length);
      result.push(message);
      continue;
    }

    result[existingIndex] = preferCanonicalUserMessage(
      result[existingIndex],
      message,
    );
  }

  return result;
}
