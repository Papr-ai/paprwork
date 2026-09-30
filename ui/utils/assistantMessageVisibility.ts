import type { ChatMessage } from "../stores/chatStore";

/** True when an assistant message has something to show beyond the Pen header. */
export function assistantMessageHasVisibleContent(
  message: ChatMessage,
): boolean {
  if (message.role !== "assistant") {
    return true;
  }

  const reasoning = (
    message.isStreaming
      ? message.streamingReasoning ?? message.reasoning
      : message.reasoning
  )?.trim();
  if (reasoning) {
    return true;
  }

  const content = (
    message.isStreaming
      ? message.streamingContent ?? message.content
      : message.content
  )?.trim();
  if (content) {
    return true;
  }

  if (message.sequence && message.sequence.length > 0) {
    return true;
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    return true;
  }

  return false;
}
