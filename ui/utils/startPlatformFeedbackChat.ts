import {
  platformFeedbackChatTitle,
  platformFeedbackInitialMessage,
  type PlatformFeedbackKind,
} from "../constants/platformFeedbackMessages";
import type { TabType } from "../types/tabs";

export async function startPlatformFeedbackChat(
  kind: PlatformFeedbackKind,
  createChat: () => Promise<string | null>,
  createTab: (type: TabType, resourceId: string, title: string) => string,
  switchToTab: (tabId: string) => void,
): Promise<boolean> {
  const chatId = await createChat();
  if (!chatId) {
    return false;
  }

  const tabId = createTab("chat", chatId, platformFeedbackChatTitle(kind));
  switchToTab(tabId);

  const message = platformFeedbackInitialMessage(kind);
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", { detail: { message } }),
    );
  }, 300);

  return true;
}
