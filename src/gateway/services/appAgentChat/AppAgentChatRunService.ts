/**
 * Desktop gateway: stream embedded app-agent chat turns via AgentService.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  AppAgentChatConfig,
  AppAgentChatSession,
  AppAgentChatSseEvent,
} from "../../../core/types/appAgentChat.js";
import {
  APP_AGENT_FILE_WRITE_TOOL_IDS,
  filterEmbeddedAppAgentToolIds,
} from "../../../core/types/appAgentChat.js";
import type { TextDeltaPayload } from "../../../core/types/streaming.js";
import { runWithToolContext } from "../../../core/tools/context.js";
import { getAgentService } from "../AgentService.js";
import { getSubAgentService } from "../SubAgentService.js";
import { getAppService } from "../AppService.js";
import { buildEmbeddedSubAgentSystemPrompt } from "./appAgentChatPrompt.js";
import { mapGatewayStreamToAppAgentEvents } from "./mapGatewayStreamToAppAgentEvents.js";
import type { AppAgentChatSessionStore } from "./AppAgentChatSessionStore.js";

export interface AppAgentChatTurnResult {
  turnId: string;
  assistantText: string;
  shouldRefreshApp: boolean;
}

export class AppAgentChatRunService {
  constructor(private readonly sessionStore: AppAgentChatSessionStore) {}

  async streamTurn(input: {
    session: AppAgentChatSession;
    userMessage: string;
    agentChat: AppAgentChatConfig;
    onEvent: (event: AppAgentChatSseEvent) => void;
  }): Promise<AppAgentChatTurnResult> {
    const turnId = uuidv4();
    const userMessage = input.userMessage.trim();
    if (!userMessage) {
      throw new Error("Message is required");
    }

    input.onEvent({ type: "app-agent:turn-start", data: { turnId } });

    const agentService = getAgentService();
    const subAgentService = getSubAgentService();
    const appService = getAppService();
    await appService.initialize();
    await subAgentService.initialize();

    const profile = await subAgentService.getAgent(input.session.subAgentId);
    if (!profile) {
      throw new Error(`Sub-agent not found: ${input.session.subAgentId}`);
    }

    const app = await appService.getApp(input.session.appId);
    if (!app) {
      throw new Error(`App not found: ${input.session.appId}`);
    }

    const systemPrompt = await buildEmbeddedSubAgentSystemPrompt({
      appId: input.session.appId,
      appTitle: app.title,
      agentChat: input.agentChat,
      subAgentName: profile.name,
      subAgentSystemPrompt: profile.systemPrompt,
    });

    const { resolveJobProviderModel } = await import(
      "../../utils/resolveJobProviderModel.js"
    );
    const { getProviderAuth, getApiKeys } = await import("../../utils/keyResolver.js");

    const resolved = await resolveJobProviderModel({
      provider: profile.provider,
      model: profile.model,
    });
    let provider = resolved.provider;
    let model = resolved.model;

    let apiKey: string | undefined;
    let authType: "oauth" | "apiKey" | undefined;

    if (provider === "openai" || provider === "openai-codex" || provider === "anthropic") {
      const authProvider = provider === "openai-codex" ? "openai" : provider;
      const auth = await getProviderAuth(authProvider);
      if (!auth) {
        throw new Error(
          `No authentication configured for ${authProvider}. Add API key or OAuth in Settings.`,
        );
      }
      apiKey = auth.type === "oauth" ? auth.token : auth.key;
      authType = auth.type;
    } else if (provider === "google") {
      const keys = await getApiKeys(["GOOGLE_API_KEY"]);
      apiKey = keys.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error("Missing GOOGLE_API_KEY in Settings.");
      }
    } else if (provider === "ollama") {
      apiKey = "";
    } else {
      const keys = await getApiKeys(["OPENAI_API_KEY"]);
      apiKey = keys.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("No provider authentication available for app-agent chat.");
      }
    }

    const allowedToolIds = filterEmbeddedAppAgentToolIds(
      input.agentChat.allowedToolIds ?? profile.allowedToolIds,
    );

    const chatId = `app-agent:${input.session.id}`;
    const config = {
      provider,
      model,
      apiKey: apiKey ?? "",
      authType,
      systemPrompt,
    };

    let assistantText = "";
    let shouldRefreshApp = false;
    const writeTools = new Set<string>(APP_AGENT_FILE_WRITE_TOOL_IDS);

    await this.sessionStore.appendMessage(input.session.id, {
      id: `msg-${uuidv4()}`,
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    await runWithToolContext(chatId, async () => {
      for await (const chunk of agentService.streamAgent(chatId, userMessage, config, {
        allowedToolIds,
        maxSteps: 20,
      })) {
        for (const event of mapGatewayStreamToAppAgentEvents(
          { type: chunk.type, payload: chunk.payload, timestamp: chunk.timestamp },
          turnId,
        )) {
          if (event.type === "app-agent:tool-result") {
            const toolName = event.data.toolName;
            if (typeof toolName === "string" && writeTools.has(toolName)) {
              shouldRefreshApp = true;
            }
          }
          input.onEvent(event);
        }
        if (chunk.type === "text-delta") {
          const payload = chunk.payload as TextDeltaPayload;
          if (typeof payload.text === "string") {
            assistantText += payload.text;
          }
        }
        if (chunk.type === "error") {
          break;
        }
      }
    });

    const trimmed = assistantText.trim();
    if (trimmed.length > 0) {
      await this.sessionStore.appendMessage(input.session.id, {
        id: `msg-${uuidv4()}`,
        role: "assistant",
        content: trimmed,
        timestamp: new Date().toISOString(),
      });
    }

    input.onEvent({
      type: "app-agent:turn-done",
      data: {
        turnId,
        assistantText: trimmed,
        shouldRefreshApp,
      },
    });

    return { turnId, assistantText: trimmed, shouldRefreshApp };
  }
}
