/**
 * Triggers the main agent to automatically respond to sub-agent questions.
 * When a sub-agent calls request_agent_input, we run the main agent with a
 * synthetic message so it can respond via respond_to_sub_agent.
 */

import { getAgentService } from "./AgentService.js";
import { getJobsService } from "./JobsService.js";
import { broadcast } from "../websocket/index.js";
import type { AgentConfigInternal, Provider } from "../../core/types/agents.js";
import { getProviderAuth } from "../utils/keyResolver.js";
import { getApiKeys } from "../utils/keyResolver.js";

/**
 * Trigger main agent to respond. Used for both sub-agent questions and user messages.
 * Gets chatId from job's reportChatId, runs streamAgent, broadcasts chunks.
 */
export async function triggerMainAgentResponse(
  delegationId: string,
  message: string,
  source: "sub-agent" | "user" = "sub-agent",
): Promise<void> {
  const jobsService = getJobsService();
  const agentService = getAgentService();

  const job = await jobsService.getJob(delegationId);
  if (!job?.reportChatId?.trim()) {
    console.log(
      `[SubAgentResponseTrigger] No reportChatId for job ${delegationId}, skipping auto-response`,
    );
    return;
  }

  const chatId = job.reportChatId;

  // Get config from session or use default
  const sessionManager = agentService.getSessionManager();
  const existingSession = sessionManager
    .getAllActiveSessions()
    .find((s) => s.chatId === chatId);

  let config: AgentConfigInternal;

  if (existingSession) {
    config = existingSession.config;
    console.log(
      `[SubAgentResponseTrigger] Using session config for chat ${chatId}`,
    );
  } else {
    // Use default provider/model and fetch key
    const provider: Provider = "anthropic";
    const model = "claude-sonnet-4-6";
    const auth = await getProviderAuth("anthropic");
    let apiKey: string;
    let authType: "oauth" | "apiKey" = "apiKey";
    if (auth) {
      apiKey = auth.type === "oauth" ? auth.token : auth.key;
      authType = auth.type;
    } else {
      const keys = await getApiKeys(["ANTHROPIC_API_KEY"]);
      apiKey = keys.ANTHROPIC_API_KEY || "";
    }
    if (!apiKey) {
      console.warn(
        "[SubAgentResponseTrigger] No API key for default provider, skipping",
      );
      return;
    }
    config = {
      provider,
      model,
      apiKey,
      authType,
      systemPrompt: "", // Will use buildContextualSystemPrompt
    };
  }

  const syntheticMessage =
    source === "user"
      ? `[User message in sub-agent chat for delegation ${delegationId}]\n\nThe user joined the mini-chat and sent: "${message}"\n\n**Your job:** Respond to the user. Use respond_to_sub_agent with delegationId "${delegationId}" and your response. Be helpful and explain what's happening with the sub-agent if relevant.`
      : `[Sub-agent question for delegation ${delegationId}]\n\n${message}\n\n**Your job:** Answer the sub-agent's question yourself using your knowledge and context. Use respond_to_sub_agent with delegationId "${delegationId}" and your answer.\n\n**If you need user help:** If you truly cannot answer (e.g. missing credentials, subjective preference, or information only they have), respond in the MAIN CHAT without using respond_to_sub_agent. Just explain the situation to the user directly. Do NOT use respond_to_sub_agent when asking the user for help - that tool is only for answering the sub-agent.`;

  console.log(
    `[SubAgentResponseTrigger] Triggering main agent for chat ${chatId}`,
  );

  try {
    for await (const chunk of agentService.streamAgent(
      chatId,
      syntheticMessage,
      config,
    )) {
      broadcast({
        type: "agent:chunk",
        data: { ...chunk, chatId, isSubAgentTrigger: true },
      });
    }
    // Send done
    const messages = await agentService.getChatHistory(chatId);
    const finalMessage = messages[messages.length - 1];
    broadcast({
      type: "agent:complete",
      data: { chatId, done: true, finalMessage },
    });
  } catch (err) {
    console.error("[SubAgentResponseTrigger] Error:", err);
    broadcast({
      type: "agent:error",
      data: {
        chatId,
        error: err instanceof Error ? err.message : "Stream error",
      },
    });
  }
}
