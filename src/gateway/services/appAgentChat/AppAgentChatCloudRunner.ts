/**
 * Cloud app host: stream embedded app-agent turns via memory → Cloud Agent Gateway SSE.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  AppAgentChatMessage,
  AppAgentChatSession,
  AppAgentChatSseEvent,
} from "../../../core/types/appAgentChat.js";
import { APP_AGENT_FILE_WRITE_TOOL_IDS } from "../../../core/types/appAgentChat.js";
import type { AppRuntimeRouteAuth } from "../appRuntime/types.js";
import { streamRuntimeAppAgentChat } from "../appRuntime/memoryRuntimeClient.js";
import { buildCloudTurnPrompt } from "./appAgentChatPrompt.js";
import { mapGatewayStreamToAppAgentEvents } from "./mapGatewayStreamToAppAgentEvents.js";
import type { AppAgentChatSessionStore } from "./AppAgentChatSessionStore.js";

export interface AppAgentChatCloudTurnInput {
  runtimeAuth: AppRuntimeRouteAuth;
  session: AppAgentChatSession;
  userMessage: string;
  cloudJobId: string;
  onEvent: (event: AppAgentChatSseEvent) => void;
}

export interface AppAgentChatCloudTurnResult {
  turnId: string;
  assistantText: string;
  shouldRefreshApp: boolean;
}

export class AppAgentChatCloudRunner {
  constructor(private readonly sessionStore: AppAgentChatSessionStore) {}

  async streamTurn(input: AppAgentChatCloudTurnInput): Promise<AppAgentChatCloudTurnResult> {
    const turnId = uuidv4();
    const userMessage = input.userMessage.trim();
    if (!userMessage) {
      throw new Error("Message is required");
    }

    input.onEvent({ type: "app-agent:turn-start", data: { turnId } });

    await this.sessionStore.appendMessage(input.session.id, {
      id: `msg-${uuidv4()}`,
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    const session = (await this.sessionStore.getSession(input.session.id)) ?? input.session;
    const history = session.messages.slice(0, -1);

    const prompt = buildCloudTurnPrompt({
      history,
      userMessage,
    });

    const memoryStream = await streamRuntimeAppAgentChat(input.runtimeAuth, {
      sessionId: input.session.id,
      appId: input.session.appId,
      subAgentId: input.session.subAgentId,
      userMessage,
      prompt,
      jobId: input.cloudJobId,
      history: history.map(toStreamHistoryMessage),
    });

    let assistantText = "";
    let shouldRefreshApp = false;
    let sawTurnDone = false;
    const writeTools = new Set<string>(APP_AGENT_FILE_WRITE_TOOL_IDS);

    for await (const raw of memoryStream) {
      const rawType = typeof raw.type === "string" ? raw.type : "";

      for (const event of mapGatewayStreamToAppAgentEvents(raw, turnId)) {
        if (event.type === "app-agent:text-delta") {
          const text = event.data.text;
          if (typeof text === "string") {
            assistantText += text;
          }
        }
        if (event.type === "app-agent:tool-result") {
          const toolName = event.data.toolName;
          if (typeof toolName === "string" && writeTools.has(toolName)) {
            shouldRefreshApp = true;
          }
        }
        if (event.type === "app-agent:turn-done") {
          sawTurnDone = true;
          const text = event.data.assistantText;
          if (typeof text === "string" && text.length > 0) {
            assistantText = text;
          }
          shouldRefreshApp = Boolean(event.data.shouldRefreshApp) || shouldRefreshApp;
        }
        input.onEvent(event);
      }

      if (rawType === "done") {
        const exitCode = raw.exitCode;
        if (typeof exitCode === "number" && exitCode !== 0 && assistantText.trim().length === 0) {
          const message =
            typeof raw.message === "string"
              ? raw.message
              : "App assistant run failed. Sign in to Papr if this app requires authentication.";
          input.onEvent({ type: "app-agent:error", data: { turnId, error: message } });
          throw new Error(message);
        }
        break;
      }
    }

    const trimmed = assistantText.trim();

    if (!sawTurnDone) {
      input.onEvent({
        type: "app-agent:turn-done",
        data: { turnId, assistantText: trimmed, shouldRefreshApp },
      });
    }

    if (trimmed.length > 0) {
      await this.sessionStore.appendMessage(input.session.id, {
        id: `msg-${uuidv4()}`,
        role: "assistant",
        content: trimmed,
        timestamp: new Date().toISOString(),
      });
    }

    return { turnId, assistantText: trimmed, shouldRefreshApp };
  }
}

function toStreamHistoryMessage(message: AppAgentChatMessage): {
  role: AppAgentChatMessage["role"];
  content: string;
} {
  return { role: message.role, content: message.content };
}
