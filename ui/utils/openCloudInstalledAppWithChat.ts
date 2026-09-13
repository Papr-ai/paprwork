/**
 * After cloud/community install: open app in split view with chat on the left.
 */

import type { CloudInstallMode } from "./cloudCatalogInstall";
import { useTabStore } from "../stores/tabStore";
import { isAppTabMergedWithChat } from "./appTabMerge";

export interface CloudInstallWelcomeInput {
  appTitle: string;
  appId: string;
  mode: CloudInstallMode;
  needsSeed?: boolean;
}

/** First message when install succeeded and the user should explore the app. */
export function buildCloudInstallWelcomeMessage(
  input: CloudInstallWelcomeInput,
): string {
  const modeLabel =
    input.mode === "track"
      ? "linked to the publisher for updates"
      : "forked locally for my workspace";

  const lines = [
    `I just installed the app "${input.appTitle}" (appId: ${input.appId}) — it is ${modeLabel}.`,
    "The app is open beside this chat. Help me get started:",
    "- Brief overview of what it does and who it is for",
    "- The first 1–2 actions I should take in the UI",
    "- Any linked jobs, schedules, databases, or API keys I should configure",
  ];

  if (input.needsSeed) {
    lines.push(
      "- The schema looks ready but data may be empty — guide me through running the seed/setup job if needed",
    );
  }

  return lines.join("\n");
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
