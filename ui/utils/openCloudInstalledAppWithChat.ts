/**
 * After cloud/community install: open app in split view with chat on the left.
 */

import { useTabStore } from "../stores/tabStore";
import { isAppTabMergedWithChat } from "./appTabMerge";

export type {
  CloudInstallWelcomeInput,
} from "./cloudCatalogInstall";
export { buildCloudInstallWelcomeMessage } from "./cloudCatalogInstall";

const SPLIT_RETRY_DELAYS_MS = [800, 2000] as const;

function ensureChatAppSplitView(
  chatTabId: string,
  appTabId: string,
  appId: string,
  appTitle: string,
): void {
  const { createTab, createArtifactFromChat, switchToTab, getTab } =
    useTabStore.getState();

  if (!getTab(chatTabId)) {
    const chatEntityId = chatTabId.startsWith("chat-")
      ? chatTabId.slice("chat-".length)
      : chatTabId;
    createTab("chat", chatEntityId, appTitle);
  }
  if (!getTab(appTabId)) {
    createTab("app", appId, appTitle);
  }

  if (!isAppTabMergedWithChat(chatTabId, appTabId)) {
    createArtifactFromChat(chatTabId, appTabId, { autoSwitch: true });
  } else {
    switchToTab(chatTabId);
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

  const chatTabId = `chat-${chatId}`;
  const appTabId = `app-${input.appId}`;
  const title = input.chatTabTitle ?? input.appTitle;

  ensureChatAppSplitView(chatTabId, appTabId, input.appId, title);

  for (const delayMs of SPLIT_RETRY_DELAYS_MS) {
    window.setTimeout(() => {
      ensureChatAppSplitView(chatTabId, appTabId, input.appId, title);
    }, delayMs);
  }

  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", {
        detail: { message: input.agentMessage },
      }),
    );
  }, 300);
}
