import type { ChatMessage } from "../stores/chatStore";

/**
 * Extracts the user-visible assistant response text for clipboard copy.
 * Includes final text after tools (or all text when no tools), excluding thinking and tool results.
 */
export function getAssistantCopyText(message: ChatMessage): string {
  if (message.role !== "assistant") {
    return "";
  }

  if (message.sequence && message.sequence.length > 0) {
    const sequence = message.sequence;
    const hasTools = sequence.some((item) => item.type === "tool");

    if (hasTools) {
      let lastToolIndex = -1;
      for (let i = sequence.length - 1; i >= 0; i--) {
        if (sequence[i].type === "tool") {
          lastToolIndex = i;
          break;
        }
      }

      return sequence
        .slice(lastToolIndex + 1)
        .filter((item) => item.type === "text" && typeof item.data === "string")
        .map((item) => (item.data as string).trim())
        .filter(Boolean)
        .join("\n\n");
    }

    return sequence
      .filter((item) => item.type === "text" && typeof item.data === "string")
      .map((item) => (item.data as string).trim())
      .filter(Boolean)
      .join("\n\n");
  }

  return (message.content || "").trim();
}
