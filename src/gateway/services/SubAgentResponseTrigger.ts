/**
 * Triggers the main agent to automatically respond to sub-agent events:
 * - Questions (request_agent_input)
 * - User messages in mini-chat
 * - Delegation finished (completed / failed)
 */

import { getAgentService } from "./AgentService.js";
import { getJobsService } from "./JobsService.js";
import { broadcast } from "../websocket/index.js";
import type { AgentConfigInternal, Provider } from "../../core/types/agents.js";
import { getProviderAuth } from "../utils/keyResolver.js";
import { getApiKeys } from "../utils/keyResolver.js";
import type { JobRecord } from "./jobs/types.js";

const notifiedDelegationFinishes = new Set<string>();

const RESULT_EXCERPT_CHARS = 4000;

interface PendingDelegationFinish {
  delegationId: string;
  outcome: "completed" | "failed";
}

/** Deferred when main agent is mid-stream in the report chat. */
const pendingDelegationFinishByChat = new Map<string, PendingDelegationFinish[]>();

async function isMainAgentStreamActive(chatId: string): Promise<boolean> {
  const { getAgentStreamRegistry } = await import("./AgentStreamRegistry.js");
  if (getAgentStreamRegistry().isStreamRunning(chatId)) {
    return true;
  }
  const { getAgentService } = await import("./AgentService.js");
  return getAgentService().getSessionManager().isStreaming(chatId);
}

function queueDelegationFinished(
  chatId: string,
  delegationId: string,
  outcome: "completed" | "failed",
): void {
  const existing = pendingDelegationFinishByChat.get(chatId) ?? [];
  if (existing.some((item) => item.delegationId === delegationId)) {
    return;
  }
  existing.push({ delegationId, outcome });
  pendingDelegationFinishByChat.set(chatId, existing);
  console.log(
    `[SubAgentResponseTrigger] Queued delegation-finished notification for ${delegationId} (chat ${chatId} busy)`,
  );
}

/**
 * Run deferred delegation-finished notifications after the main agent stream ends.
 */
export async function flushPendingDelegationNotifications(
  chatId: string,
): Promise<void> {
  const pending = pendingDelegationFinishByChat.get(chatId);
  if (!pending?.length) return;
  pendingDelegationFinishByChat.delete(chatId);

  for (const item of pending) {
    await triggerMainAgentOnDelegationFinished(
      item.delegationId,
      item.outcome,
    );
  }
}

async function resolveConfigForChat(
  chatId: string,
): Promise<AgentConfigInternal | null> {
  const agentService = getAgentService();
  const sessionManager = agentService.getSessionManager();
  const existingSession = sessionManager
    .getAllActiveSessions()
    .find((s) => s.chatId === chatId);

  if (existingSession) {
    console.log(
      `[SubAgentResponseTrigger] Using session config for chat ${chatId}`,
    );
    return existingSession.config;
  }

  const provider: Provider = "anthropic";
  const model = "claude-sonnet-5";
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
    const paprKeys = await getApiKeys(["PAPR_API_KEY"]);
    if (paprKeys.PAPR_API_KEY) {
      console.log(
        "[SubAgentResponseTrigger] No direct API key — falling back to Papr AI proxy",
      );
      return {
        provider,
        model,
        apiKey: paprKeys.PAPR_API_KEY,
        authType,
        usePaprProxy: true,
        systemPrompt: "",
      };
    }
    console.warn(
      "[SubAgentResponseTrigger] No API key for default provider, skipping",
    );
    return null;
  }

  return {
    provider,
    model,
    apiKey,
    authType,
    systemPrompt: "",
  };
}

async function runMainAgentStream(
  chatId: string,
  syntheticMessage: string,
  config: AgentConfigInternal,
): Promise<void> {
  const agentService = getAgentService();

  console.log(
    `[SubAgentResponseTrigger] Triggering main agent for chat ${chatId}`,
  );

  try {
    for await (const chunk of agentService.streamAgent(
      chatId,
      syntheticMessage,
      config,
      { isSubAgentTrigger: true },
    )) {
      broadcast({
        type: "agent:chunk",
        data: { ...chunk, chatId, isSubAgentTrigger: true },
      });
    }
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

async function loadDelegationResultText(
  delegationId: string,
  job: JobRecord,
): Promise<{ text: string; agentName: string }> {
  let best = job.lastOutput?.trim() ?? "";
  let agentName =
    job.name?.replace(/^Delegation:\s*/i, "").trim() || "Sub-agent";

  try {
    const { getSubAgentService } = await import("./SubAgentService.js");
    const service = getSubAgentService();
    if (job.subAgentId) {
      const profile = await service.getAgent(job.subAgentId);
      if (profile?.name) agentName = profile.name;
    }

    const messages = await service.loadDelegationChatMessages(delegationId, 30);
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.content.trim()) continue;
      const fromSubAgent =
        msg.source_agent_id !== undefined &&
        msg.source_agent_id !== "main-agent";
      if (fromSubAgent || msg.content.length > best.length) {
        if (msg.content.length > best.length) {
          best = msg.content;
        }
      }
    }
  } catch (err) {
    console.warn(
      `[SubAgentResponseTrigger] Could not load delegation chat for ${delegationId}:`,
      err,
    );
  }

  return { text: best, agentName };
}

function buildResultExcerpt(text: string): string {
  if (text.length <= RESULT_EXCERPT_CHARS) return text;
  return (
    `${text.slice(0, RESULT_EXCERPT_CHARS)}\n\n` +
    `[... ${text.length - RESULT_EXCERPT_CHARS} more chars — use get_delegation_run({ runId }) for full text]`
  );
}

/**
 * When a sub-agent delegation job finishes, wake the main agent so it can
 * post a user-facing update (summary + pointer to full report card).
 */
export async function triggerMainAgentOnDelegationFinished(
  delegationId: string,
  outcome: "completed" | "failed",
): Promise<void> {
  if (notifiedDelegationFinishes.has(delegationId)) {
    console.log(
      `[SubAgentResponseTrigger] Already notified for ${delegationId}, skipping`,
    );
    return;
  }

  const jobsService = getJobsService();
  const job = await jobsService.getJob(delegationId);
  if (!job || job.type !== "subagent" || !job.reportChatId?.trim()) {
    return;
  }

  const chatId = job.reportChatId;

  if (outcome === "failed" && job.nextRetryAt) {
    console.log(
      `[SubAgentResponseTrigger] Delegation ${delegationId} will retry, skipping notification`,
    );
    return;
  }

  if (await isMainAgentStreamActive(chatId)) {
    queueDelegationFinished(chatId, delegationId, outcome);
    return;
  }

  const config = await resolveConfigForChat(chatId);
  if (!config) return;

  notifiedDelegationFinishes.add(delegationId);

  const task = job.delegationTask ?? job.command ?? "Delegated task";
  const { text: resultText, agentName } = await loadDelegationResultText(
    delegationId,
    job,
  );

  let syntheticMessage: string;

  if (outcome === "failed") {
    const errorDetail = job.error?.trim() || "Unknown error";
    syntheticMessage =
      `[Sub-agent delegation finished for ${delegationId}]\n\n` +
      `The **${agentName}** sub-agent **failed**.\n\n` +
      `Task: ${task}\n\n` +
      `Error: ${errorDetail}\n\n` +
      `**Your job:** Tell the user what happened in this chat. Explain the failure briefly and suggest concrete next steps (retry delegation, fix config, gather missing info). ` +
      `Do NOT start another delegation unless the user asks.`;
  } else {
    const excerpt = resultText
      ? buildResultExcerpt(resultText)
      : "(No textual output produced)";
    const fullLen = resultText.length;

    syntheticMessage =
      `[Sub-agent delegation finished for ${delegationId}]\n\n` +
      `The **${agentName}** sub-agent has **completed** its task.\n\n` +
      `Task: ${task}\n\n` +
      (fullLen > 0
        ? `Result (${fullLen} chars total):\n${excerpt}\n\n`
        : "") +
      `**Your job:** Post an update in this chat for the user **now**. Summarize the most important findings, recommendations, and next steps. ` +
      `Tell them the full report is on the delegation card in this chat (expand the **${agentName}** card on the message where you delegated). ` +
      `Use get_delegation_run({ runId: "${delegationId}" }) if you need the complete text before summarizing. ` +
      `Do NOT say you are still waiting for the sub-agent — it is done. Do NOT re-delegate unless the user asks.`;
  }

  await runMainAgentStream(chatId, syntheticMessage, config);
}

/**
 * Trigger main agent to respond. Used for sub-agent questions and user mini-chat messages.
 */
export async function triggerMainAgentResponse(
  delegationId: string,
  message: string,
  source: "sub-agent" | "user" = "sub-agent",
): Promise<void> {
  const jobsService = getJobsService();
  const job = await jobsService.getJob(delegationId);
  if (!job?.reportChatId?.trim()) {
    console.log(
      `[SubAgentResponseTrigger] No reportChatId for job ${delegationId}, skipping auto-response`,
    );
    return;
  }

  const chatId = job.reportChatId;

  if (job.status === "running" && source === "sub-agent") {
    console.log(
      `[SubAgentResponseTrigger] Running delegation ${delegationId}, ` +
        `auto-responding so main agent can route question (to itself or user).`,
    );
  }

  const config = await resolveConfigForChat(chatId);
  if (!config) return;

  const syntheticMessage =
    source === "user"
      ? `[User message in sub-agent chat for delegation ${delegationId}]\n\nThe user joined the mini-chat and sent: "${message}"\n\n**Your job:** Respond to the user. Use respond_to_sub_agent with delegationId "${delegationId}" and your response. Be helpful and explain what's happening with the sub-agent if relevant.`
      : `[Sub-agent question for delegation ${delegationId}]\n\n${message}\n\n**Your job:** Answer the sub-agent's question yourself using your knowledge and context. Use respond_to_sub_agent with delegationId "${delegationId}" and your answer.\n\n**If you need user help:** If you truly cannot answer (e.g. missing credentials, subjective preference, or information only they have), respond in the MAIN CHAT without using respond_to_sub_agent. Just explain the situation to the user directly. Do NOT use respond_to_sub_agent when asking the user for help - that tool is only for answering the sub-agent.`;

  await runMainAgentStream(chatId, syntheticMessage, config);
}
