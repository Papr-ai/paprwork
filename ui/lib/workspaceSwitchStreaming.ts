/**
 * Detect active agent streams before org/namespace workspace switch (in-memory only).
 */

import { activeStreamRequests, untrackActiveStream } from "./agentStreamRecovery";
import { useChatStore } from "../stores/chatStore";
import { gateway } from "../src/lib/gateway";

/** Chat ids with an in-flight or UI-visible agent stream. */
export function getActiveStreamChatIds(): string[] {
  const ids = new Set<string>();

  for (const chatId of activeStreamRequests.keys()) {
    ids.add(chatId);
  }

  const store = useChatStore.getState();

  for (const chat of store.chats) {
    if (chat.isStreaming) {
      ids.add(chat.id);
    }
  }

  for (const [chatId, state] of store.chatStates.entries()) {
    if (state.isStreaming || state.isSending) {
      ids.add(chatId);
    }
    if (state.messages.some((m) => m.isStreaming)) {
      ids.add(chatId);
    }
  }

  for (const chatId of store.streamingState.keys()) {
    ids.add(chatId);
  }

  return [...ids];
}

export function hasActiveAgentStreams(): boolean {
  return getActiveStreamChatIds().length > 0;
}

/** Stop gateway streams and clear local streaming UI for the given chats. */
export async function abortActiveAgentStreams(
  chatIds: string[] = getActiveStreamChatIds(),
): Promise<void> {
  if (chatIds.length === 0) {
    return;
  }

  await Promise.all(
    chatIds.map(async (chatId) => {
      const requestId = activeStreamRequests.get(chatId);
      if (requestId) {
        gateway.cancelRequest(requestId);
        untrackActiveStream(chatId);
      }
      await gateway.send("agent:stop", { chatId }).catch(() => {});
    }),
  );

  const store = useChatStore.getState();
  for (const chatId of chatIds) {
    store.setSending(chatId, false);
    store.setChatStreaming(chatId, false);
    const chatState = store.chatStates.get(chatId);
    const streamingMsg = chatState?.messages.find((m) => m.isStreaming);
    if (streamingMsg) {
      store.finalizeStreamingMessage(streamingMsg.id, chatId);
    }
  }
}

/**
 * If streams are active, confirm with the user and abort them before switching.
 * Returns true when switching should proceed.
 */
export async function confirmAndAbortStreamsForWorkspaceSwitch(): Promise<boolean> {
  const ids = getActiveStreamChatIds();
  if (ids.length === 0) {
    return true;
  }

  const label =
    ids.length === 1
      ? "An agent is still working"
      : `${ids.length} agents are still working`;

  const proceed = window.confirm(
    `${label} in your chats. Switching workspace will stop active responses.\n\nSwitch anyway?`,
  );
  if (!proceed) {
    return false;
  }

  await abortActiveAgentStreams(ids);
  return true;
}
