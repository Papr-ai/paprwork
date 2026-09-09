import {
  buildClaudeManualAgentPrompt,
  CLAUDE_MANUAL_AGENT_MODEL_ID,
  detectManualConnectionPlatform,
  type ManualConnectionPlatform,
} from "../constants/claudeManualConnection";
import type { TabType } from "../types/tabs";
import { useChatStore } from "../stores/chatStore";

export async function startClaudeManualAgentChat(
  createChat: () => Promise<string | null>,
  createTab: (type: TabType, resourceId: string, title: string) => string,
  switchToTab: (tabId: string) => void,
  platform: ManualConnectionPlatform = detectManualConnectionPlatform(),
): Promise<boolean> {
  const chatId = await createChat();
  if (!chatId) {
    return false;
  }

  const tabId = createTab("chat", chatId, "Connect Claude");
  useChatStore.getState().setLastSelectedModel(chatId, CLAUDE_MANUAL_AGENT_MODEL_ID);
  switchToTab(tabId);

  const message = buildClaudeManualAgentPrompt(platform);
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", { detail: { message } }),
    );
  }, 300);

  return true;
}
