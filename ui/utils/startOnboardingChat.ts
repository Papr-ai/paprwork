import { ONBOARDING_SETUP_MESSAGE } from "../constants/onboardingMessages";
import type { TabType } from "../types/tabs";

export function markOnboardingStep1Started(): void {
  localStorage.setItem("papr-onboarding-step1", "true");
  window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
}

export async function startOnboardingChat(
  createChat: () => Promise<string | null>,
  createTab: (type: TabType, resourceId: string, title: string) => string,
  switchToTab: (tabId: string) => void,
  message: string = ONBOARDING_SETUP_MESSAGE,
): Promise<boolean> {
  const chatId = await createChat();
  if (!chatId) {
    return false;
  }

  const tabId = createTab("chat", chatId, "New Chat");
  switchToTab(tabId);

  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", { detail: { message } }),
    );
  }, 300);

  markOnboardingStep1Started();
  return true;
}

export function openPaprSignInSettings(
  createTab: (type: TabType, resourceId: string, title: string) => string,
  switchToTab: (tabId: string) => void,
): void {
  const tabId = createTab("settings", "settings", "Settings");
  switchToTab(tabId);
  window.dispatchEvent(
    new CustomEvent("papr:open-settings", { detail: { tab: "models" } }),
  );
}
