/**
 * After cloud/community/onboarding install: open app in split view with chat on the left.
 *
 * Two traps this guards against (both produced "chat and app in separate tabs"):
 * 1. createTab("chat", temp-id) may REUSE an existing blank chat tab and return
 *    a different tab id. We must merge into the id it returns, not the one we
 *    computed — otherwise createArtifactFromChat can't find the chat and no-ops.
 * 2. The first send swaps the temp chat id for the real one (updateTabId), so the
 *    original chat tab id disappears. Retries must follow the app's pairing and
 *    never create a fresh chat, or they pull the app away from the real chat.
 */

import { useTabStore } from "../stores/tabStore";
import {
  findPairedChatTabIdForAppTab,
  isAppTabMergedWithChat,
} from "./appTabMerge";

export type {
  CloudInstallWelcomeInput,
} from "./cloudCatalogInstall";
export { buildCloudInstallWelcomeMessage } from "./cloudCatalogInstall";

const SPLIT_RETRY_DELAYS_MS = [800, 2000] as const;

interface SplitState {
  chatTabId: string;
  chatEntityId: string;
  appTabId: string;
  appId: string;
  appTitle: string;
  chatTitle: string;
}

/** Idempotent: safe to call on retry timers. */
function ensureChatAppSplitView(state: SplitState, allowCreateChat: boolean): void {
  const { createTab, createArtifactFromChat, switchToTab, getTab } =
    useTabStore.getState();

  if (!getTab(state.chatTabId)) {
    // Temp → real id swap after the first send: follow the existing pairing.
    const paired = findPairedChatTabIdForAppTab(state.appTabId);
    if (paired) {
      state.chatTabId = paired;
    } else if (allowCreateChat) {
      state.chatTabId = createTab("chat", state.chatEntityId, state.chatTitle);
    } else {
      // Never mint a new chat on retry — it would steal the app from the real one.
      return;
    }
  }

  if (!getTab(state.appTabId)) {
    createTab("app", state.appId, state.appTitle);
  }

  if (!isAppTabMergedWithChat(state.chatTabId, state.appTabId)) {
    createArtifactFromChat(state.chatTabId, state.appTabId, { autoSwitch: true });
  } else {
    switchToTab(state.chatTabId);
  }
}

export async function openCloudInstalledAppWithChat(
  createChat: () => Promise<string | null>,
  input: {
    appId: string;
    appTitle: string;
    agentMessage: string;
    chatTabTitle?: string;
  },
): Promise<void> {
  const chatId = await createChat();
  if (!chatId) return;

  const state: SplitState = {
    chatTabId: `chat-${chatId}`,
    chatEntityId: chatId,
    appTabId: `app-${input.appId}`,
    appId: input.appId,
    appTitle: input.appTitle,
    chatTitle: input.chatTabTitle ?? input.appTitle,
  };

  ensureChatAppSplitView(state, true);

  for (const delayMs of SPLIT_RETRY_DELAYS_MS) {
    window.setTimeout(() => ensureChatAppSplitView(state, false), delayMs);
  }

  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", {
        detail: { message: input.agentMessage },
      }),
    );
  }, 300);
}
