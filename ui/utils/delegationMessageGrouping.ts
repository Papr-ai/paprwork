import type { ChatMessage } from "../stores/chatStore";

export interface GroupedChatMessage extends ChatMessage {
  /** Auto-triggered Pen summaries after sub-agent delegation — render inside Working card */
  delegationFollowUps?: ChatMessage[];
}

function messageHasDelegateTask(message: ChatMessage): boolean {
  if (message.toolCalls?.some((tc) => tc.toolName === "delegate_task")) {
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

/** Text-only assistant turns right after delegation (SubAgentResponseTrigger summaries). */
function isDelegationFollowUp(message: ChatMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const tools = message.toolCalls ?? [];
  if (tools.length === 0) {
    return true;
  }
  return tools.every((tc) => tc.toolName === "respond_to_sub_agent");
}

export function groupDelegationFollowUpMessages(
  messages: ChatMessage[],
): GroupedChatMessage[] {
  const grouped: GroupedChatMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "assistant" && messageHasDelegateTask(message)) {
      const followUps: ChatMessage[] = [];
      let nextIndex = index + 1;
      while (
        nextIndex < messages.length &&
        isDelegationFollowUp(messages[nextIndex])
      ) {
        followUps.push(messages[nextIndex]);
        nextIndex += 1;
      }
      grouped.push({
        ...message,
        delegationFollowUps:
          followUps.length > 0 ? followUps : undefined,
      });
      index = nextIndex;
      continue;
    }
    grouped.push(message);
    index += 1;
  }

  return grouped;
}
