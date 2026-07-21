/**
 * Prompt helpers for embedded app-agent chat turns.
 */

import type {
  AppAgentChatConfig,
  AppAgentChatMessage,
} from "../../../core/types/appAgentChat.js";
import { buildAppAgentChatContext } from "../../../core/types/appAgentChat.js";
import {
  jobAppDatabasePromptLines,
  requireJobAppDatabase,
} from "../jobAppDatabase.js";

export async function buildAppAgentEnvBlock(appId: string): Promise<string> {
  const appDb = await requireJobAppDatabase([appId]);
  if (!appDb) {
    return `\n=== APP CONTEXT ===\nAPP_ID="${appId}"\n=======================`;
  }
  return `\n=== APP CONTEXT ===\n${jobAppDatabasePromptLines(appDb).join("\n")}\n=======================`;
}

export function buildCloudTurnPrompt(input: {
  history: AppAgentChatMessage[];
  userMessage: string;
}): string {
  const historyBlock = input.history
    .slice(-24)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  return [
    "=== EMBEDDED APP CHAT TURN ===",
    "Respond directly to the app user in this conversation.",
    "Do not delegate to the main agent or ask for relay via request_agent_input.",
    historyBlock,
    `USER: ${input.userMessage}`,
    "ASSISTANT:",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function buildEmbeddedSubAgentSystemPrompt(input: {
  appId: string;
  appTitle: string;
  agentChat: AppAgentChatConfig;
  subAgentName: string;
  subAgentSystemPrompt: string;
}): Promise<string> {
  const envBlock = await buildAppAgentEnvBlock(input.appId);
  const appContext = buildAppAgentChatContext(
    input.appId,
    input.appTitle,
    input.agentChat,
  );
  return [
    `[Sub-Agent: ${input.subAgentName}]`,
    input.subAgentSystemPrompt,
    appContext,
    envBlock,
    "You are chatting with an end user inside the mini-app. Answer them directly.",
  ].join("\n\n");
}
