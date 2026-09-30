/**
 * Minimal agent config for reconnect / stream-recovery retries when ChatContainer
 * is not mounted (tab switch) or multiple chats need recovery at once.
 */

import { getModelById } from "../constants/models";
import { PICKER_DEFAULT_MODEL_IDS } from "../constants/modelPicker";
import { useChatStore } from "../stores/chatStore";
import { readChatSettings } from "./chatModelSettings";
import {
  buildAgentConfig,
  type BuiltAgentConfig,
} from "./buildAgentConfig";
import {
  findHistoryModelId,
  resolveChatModelId,
} from "./resolveChatModel";

const RECOVERY_SYSTEM_PROMPT = `You're Pen, an AI assistant in Paprwork. Continue the in-progress turn without repeating work you already completed.`;

export function buildRecoveryAgentConfigForChat(
  chatId: string,
): BuiltAgentConfig | undefined {
  const store = useChatStore.getState();
  const chatState = store.chatStates.get(chatId);
  if (!chatState) return undefined;

  const modelId = resolveChatModelId({
    perChatModelId: store.getLastSelectedModel(chatId),
    historyModelId: findHistoryModelId(chatState.messages),
    newChatDefaultModelId: store.getDefaultModelForNewChat(),
    hasHistory: chatState.messages.length > 0,
  });

  const fallbackId = PICKER_DEFAULT_MODEL_IDS[0];
  const model =
    (modelId ? getModelById(modelId) : undefined) ??
    (fallbackId ? getModelById(fallbackId) : undefined);

  if (!model) return undefined;

  return buildAgentConfig({
    model,
    settings: readChatSettings(chatId),
    systemPrompt: RECOVERY_SYSTEM_PROMPT,
  });
}
