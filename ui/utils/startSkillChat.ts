import type { TabType } from "../types/tabs";

export function buildSkillUseMessage(skillId: string, skillName: string): string {
  return `Use the "${skillName}" skill. Start with read_skill({ skillId: "${skillId}" }).`;
}

export async function startSkillChat(
  createChat: () => Promise<string | null>,
  createTab: (type: TabType, resourceId: string, title: string) => string,
  switchToTab: (tabId: string) => void,
  skillId: string,
  skillName: string,
): Promise<boolean> {
  const chatId = await createChat();
  if (!chatId) {
    return false;
  }

  const tabId = createTab("chat", chatId, "New Chat");
  switchToTab(tabId);

  const message = buildSkillUseMessage(skillId, skillName);

  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", { detail: { message } }),
    );
  }, 300);

  return true;
}
