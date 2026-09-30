import { gateway } from "../src/lib/gateway";
import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { isHiddenContinueUserMessage } from "./agentStreamRecovery";

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
