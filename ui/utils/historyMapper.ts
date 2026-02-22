import type { ChatMessage } from "../types/chat";

/** Synthetic user messages injected by SubAgentResponseTrigger - shown only in MiniChatCard, not main chat */
function isSyntheticSubAgentMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const role = (msg as Record<string, unknown>).role;
  const content =
    typeof (msg as Record<string, unknown>).content === "string"
      ? ((msg as Record<string, unknown>).content as string)
      : "";
  if (role !== "user") return false;
  return (
    content.startsWith("[Sub-agent question for delegation ") ||
    content.startsWith("[User message in sub-agent chat for delegation ")
  );
}

/** Filter out synthetic sub-agent exchange (user + assistant response) - shown only in MiniChatCard */
function filterSyntheticSubAgentExchange(history: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (isSyntheticSubAgentMessage(msg)) {
      // Skip synthetic user message and the immediately following assistant response
      const next = history[i + 1];
      const nextIsAssistant =
        typeof next === "object" &&
        next !== null &&
        (next as Record<string, unknown>).role === "assistant";
      if (nextIsAssistant) i++; // Skip next too
      continue;
    }
    result.push(msg);
  }
  return result;
}

export function mapHistoryMessages(
  history: unknown[],
  timestampSeed: number = Date.now(),
): ChatMessage[] {
  const filtered = filterSyntheticSubAgentExchange(history);
  return filtered.map((msg, index) => {
    const candidate =
      typeof msg === "object" && msg !== null
        ? (msg as Record<string, unknown>)
        : {};

    const role = candidate.role === "assistant" ? "assistant" : "user";
    const content =
      typeof candidate.content === "string" ? candidate.content : "";
    const reasoning =
      typeof candidate.reasoning === "string"
        ? candidate.reasoning
        : typeof candidate.thinking === "string"
          ? candidate.thinking
          : undefined;

    const toolCallsRaw = Array.isArray(candidate.toolCalls)
      ? candidate.toolCalls
      : [];
    const toolCalls =
      toolCallsRaw.length > 0
        ? toolCallsRaw.map((rawToolCall, toolIndex) => {
            const toolCandidate =
              typeof rawToolCall === "object" && rawToolCall !== null
                ? (rawToolCall as Record<string, unknown>)
                : {};

            const toolNameValue =
              typeof toolCandidate.toolName === "string"
                ? toolCandidate.toolName
                : typeof toolCandidate.name === "string"
                  ? toolCandidate.name
                  : "tool";

            const statusValue =
              toolCandidate.status === "calling" ||
              toolCandidate.status === "success" ||
              toolCandidate.status === "error"
                ? toolCandidate.status
                : "success";

            return {
              id:
                typeof toolCandidate.id === "string"
                  ? toolCandidate.id
                  : `tool-${timestampSeed}-${index}-${toolIndex}`,
              toolName: toolNameValue,
              args:
                typeof toolCandidate.args === "object" &&
                toolCandidate.args !== null &&
                !Array.isArray(toolCandidate.args)
                  ? (toolCandidate.args as Record<string, unknown>)
                  : {},
              status: statusValue,
              result:
                typeof toolCandidate.result === "string"
                  ? toolCandidate.result
                  : typeof toolCandidate.result === "object" &&
                      toolCandidate.result !== null
                    ? JSON.stringify(toolCandidate.result)
                    : undefined,
              error:
                typeof toolCandidate.error === "string"
                  ? toolCandidate.error
                  : undefined,
            };
          })
        : undefined;

    // Parse V1-style sequence if present
    const sequenceRaw = Array.isArray(candidate.sequence)
      ? candidate.sequence
      : undefined;

    return {
      id:
        typeof candidate.id === "string"
          ? candidate.id
          : `msg-${timestampSeed}-${index}`,
      role,
      content,
      reasoning,
      toolCalls,
      sequence: sequenceRaw, // Include sequence for interleaved rendering
    };
  });
}
