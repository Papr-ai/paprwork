import { parseDelegationFromToolResult } from "../components/Chat/DelegationCard";
import type { ChatMessage } from "../stores/chatStore";

export interface GroupedChatMessage extends ChatMessage {
  /** Auto-triggered Pen summaries after sub-agent delegation */
  delegationFollowUps?: ChatMessage[];
}

const DELEGATION_FINISHED_USER =
  /^\[Sub-agent delegation finished for ([^\]]+)\]/;

export function extractDelegationFinishedId(content: string): string | null {
  const match = content.trim().match(DELEGATION_FINISHED_USER);
  return match?.[1]?.trim() ?? null;
}

function isSyntheticDelegationFinishedUser(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    extractDelegationFinishedId(message.content) !== null
  );
}

function messageHasDelegateTask(message: ChatMessage): boolean {
  if (message.toolCalls?.some((toolCall) => toolCall.toolName === "delegate_task")) {
    return true;
  }
  return (
    message.sequence?.some(
      (item) =>
        item.type === "tool" &&
        typeof item.data === "object" &&
        item.data !== null &&
        (item.data as { name?: string }).name === "delegate_task",
    ) ?? false
  );
}

/** Text-only assistant turns after delegation (SubAgentResponseTrigger summaries). */
function isDelegationFollowUp(message: ChatMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const tools = message.toolCalls ?? [];
  if (tools.length === 0) {
    return true;
  }
  return tools.every((toolCall) => toolCall.toolName === "respond_to_sub_agent");
}

function collectDelegationIds(message: ChatMessage): string[] {
  const ids = new Set<string>();

  const collect = (
    toolName: string,
    result: unknown,
    args?: Record<string, unknown>,
  ): void => {
    if (toolName !== "delegate_task") return;
    const parsed = parseDelegationFromToolResult(toolName, result);
    if (parsed?.id) {
      ids.add(parsed.id);
      return;
    }
    const jobId = args?.jobId;
    if (typeof jobId === "string" && jobId.trim()) {
      ids.add(jobId.trim());
    }
  };

  message.toolCalls?.forEach((toolCall) => {
    collect(toolCall.toolName, toolCall.result, toolCall.args);
  });

  message.sequence?.forEach((item) => {
    if (item.type !== "tool") return;
    if (typeof item.data !== "object" || item.data === null) return;
    const data = item.data as {
      name?: string;
      output?: unknown;
      input?: Record<string, unknown>;
      result?: unknown;
    };
    if (data.name !== "delegate_task") return;
    collect(
      "delegate_task",
      data.output ?? data.result,
      data.input,
    );
  });

  return [...ids];
}

function buildFollowUpsByDelegationId(
  messages: ChatMessage[],
): Map<string, ChatMessage[]> {
  const followUpsByDelegationId = new Map<string, ChatMessage[]>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const delegationId = extractDelegationFinishedId(message.content);
    if (!delegationId) continue;

    const followUps: ChatMessage[] = [];
    let nextIndex = index + 1;
    while (
      nextIndex < messages.length &&
      isDelegationFollowUp(messages[nextIndex])
    ) {
      followUps.push(messages[nextIndex]);
      nextIndex += 1;
    }

    if (followUps.length > 0) {
      const existing = followUpsByDelegationId.get(delegationId) ?? [];
      followUpsByDelegationId.set(delegationId, [...existing, ...followUps]);
    }
  }

  return followUpsByDelegationId;
}

function collectAdjacentFollowUps(
  messages: ChatMessage[],
  startIndex: number,
): { followUps: ChatMessage[]; nextIndex: number } {
  const followUps: ChatMessage[] = [];
  let nextIndex = startIndex + 1;
  while (
    nextIndex < messages.length &&
    isDelegationFollowUp(messages[nextIndex])
  ) {
    followUps.push(messages[nextIndex]);
    nextIndex += 1;
  }
  return { followUps, nextIndex };
}

export function groupDelegationFollowUpMessages(
  messages: ChatMessage[],
): GroupedChatMessage[] {
  const followUpsByDelegationId = buildFollowUpsByDelegationId(messages);
  const consumedFollowUpIds = new Set<string>();
  const grouped: GroupedChatMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (isSyntheticDelegationFinishedUser(message)) {
      continue;
    }

    if (consumedFollowUpIds.has(message.id)) {
      continue;
    }

    if (message.role === "assistant" && messageHasDelegateTask(message)) {
      const adjacent = collectAdjacentFollowUps(messages, index);
      const delegationIds = collectDelegationIds(message);
      const attachedFollowUps: ChatMessage[] = [...adjacent.followUps];

      for (const delegationId of delegationIds) {
        const deferred = followUpsByDelegationId.get(delegationId) ?? [];
        for (const followUp of deferred) {
          if (consumedFollowUpIds.has(followUp.id)) continue;
          attachedFollowUps.push(followUp);
          consumedFollowUpIds.add(followUp.id);
        }
      }

      for (const followUp of adjacent.followUps) {
        consumedFollowUpIds.add(followUp.id);
      }

      grouped.push({
        ...message,
        delegationFollowUps:
          attachedFollowUps.length > 0 ? attachedFollowUps : undefined,
      });
      index = adjacent.nextIndex - 1;
      continue;
    }

    grouped.push(message);
  }

  return grouped;
}
