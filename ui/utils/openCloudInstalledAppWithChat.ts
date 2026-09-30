/**
 * After cloud/community install: open app in split view with chat on the left.
 */

import { useTabStore } from "../stores/tabStore";
import { isAppTabMergedWithChat } from "./appTabMerge";

export type {
  CloudInstallWelcomeInput,
} from "./cloudCatalogInstall";
export { buildCloudInstallWelcomeMessage } from "./cloudCatalogInstall";

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

  const { createTab, createArtifactFromChat, switchToTab, getTab } =
    useTabStore.getState();

  const chatTabId = `chat-${chatId}`;
  if (!getTab(chatTabId)) {
    createTab("chat", chatId, input.chatTabTitle ?? input.appTitle);
  }

  const appTabId = `app-${input.appId}`;
  if (!getTab(appTabId)) {
    createTab("app", input.appId, input.appTitle);
  }

  if (!isAppTabMergedWithChat(chatTabId, appTabId)) {
    createArtifactFromChat(chatTabId, appTabId, { autoSwitch: true });
  } else {
    switchToTab(chatTabId);
  }

  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", {
        detail: { message: input.agentMessage },
      }),
    );
  }, 300);
}
