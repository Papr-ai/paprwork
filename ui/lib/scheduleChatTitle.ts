import { gateway } from "../src/lib/gateway";
import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { isHiddenContinueUserMessage } from "./agentStreamRecovery";

/**
 * A title the chat was opened with on purpose ("Review shared data", "Set up
 * HubSpot"): kept instead of being replaced by one generated from the prompt.
 * The default "New Chat" tab title means none was given.
 */
export function presetChatTitle(tabTitle: string | undefined): string | undefined {
  const title = tabTitle?.trim();
  return title && title !== "New Chat" ? title : undefined;
}

/**
 * Title generation does not need to wait for the agent stream to finish.
 * Scheduling right after chat:create lets tabs and the sidebar update even when
 * the turn errors, disconnects, or runs for a long time.
 */
export function scheduleChatTitleGeneration(
  chatId: string,
  firstMessage: string,
): void {
  if (isHiddenContinueUserMessage(firstMessage)) {
    return;
  }

  void gateway
    .send("agent:generate-title", {
      chatId,
      message: firstMessage,
    })
    .then((titleResponse) => {
      const data = titleResponse.data as { title?: string } | undefined;
      const title = data?.title?.trim() || "New Chat";
      useTabStore.getState().updateTabTitle(`chat-${chatId}`, title);
      useChatStore.getState().patchChatTitle(chatId, title);
    })
    .catch((titleError) => {
      console.error("[scheduleChatTitle] Failed to generate title:", titleError);
    });
}
