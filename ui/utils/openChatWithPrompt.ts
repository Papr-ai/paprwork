/**
 * Open a fresh chat tab and send `message` into it.
 *
 * `papr-onboarding-send` is only heard by a MOUNTED ChatContainer. Dispatching
 * it with no chat open drops the prompt silently — which is what happened to
 * the gated freeform path, since the workspace had only just mounted.
 *
 * Store-only on purpose (getState, no hooks): the gated RecommendStep unmounts
 * the moment it releases the gate, so this must not depend on that component
 * staying alive. Mirrors useChat().createChat(temp id) + OnboardingView's
 * sendInNewChat.
 */

import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";

/** Delay lets the new tab's ChatContainer mount and attach its listener. */
const SEND_DELAY_MS = 300;

export function openChatWithPrompt(message: string): void {
  const chatId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const { chatStates } = useChatStore.getState();
  const next = new Map(chatStates);
  next.set(chatId, {
    messages: [],
    isLoading: false,
    isSending: false,
    isStreaming: false,
    hasUnread: false,
  });
  useChatStore.setState({ chatStates: next });

  const { createTab, switchToTab } = useTabStore.getState();
  const tabId = createTab("chat", chatId, "New Chat");
  switchToTab(tabId);

  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", { detail: { message } }),
    );
  }, SEND_DELAY_MS);
}
