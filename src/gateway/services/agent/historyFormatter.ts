/**
 * History Formatter - Converts stored messages to AI SDK compatible format
 *
 * CRITICAL: Tool calls must be represented as structured content parts,
 * NOT as plain text. If tool calls are serialized as text (e.g. "[tool_activity]"),
 * the model learns to generate fake tool call text instead of actually invoking tools.
 *
 * AI SDK expected message format for tool calls:
 * 1. { role: "assistant", content: [{ type: "text", ... }, { type: "tool-call", ... }] }
 * 2. { role: "tool", content: [{ type: "tool-result", ... }] }
 *
 * CONTEXT MANAGEMENT:
 * - Tool results in storage can be up to 100KB each (MAX_TOOL_RESULT_LENGTH)
 * - When loading history into LLM context, tool results are truncated to 2000 chars max
 * - Full results remain in storage for UI display and debugging
 * - This prevents context length exceeded errors during long tool-heavy conversations
 */

// ---------------------------------------------------------------------------
// AI SDK compatible content part types
// These match the format expected by streamText / generateText from 'ai'
// ---------------------------------------------------------------------------

interface TextContentPart {
  type: "text";
  text: string;
}

interface ToolCallContentPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolResultContentPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
}

type AssistantContent = Array<TextContentPart | ToolCallContentPart>;
type ToolContent = Array<ToolResultContentPart>;

// ---------------------------------------------------------------------------
// AI SDK compatible message types
// ---------------------------------------------------------------------------

export type AIModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | AssistantContent }
  | { role: "tool"; content: ToolContent };

/**
 * @deprecated Use AIModelMessage instead. Kept for backward compatibility
 * with code that expects simple string content.
 */
export type ModelMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ModelMessageRole = "user" | "assistant" | "system" | "tool";

// ---------------------------------------------------------------------------
// Internal extraction helpers
// ---------------------------------------------------------------------------

interface ToolCallLike {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  result?: unknown;
  status?: unknown;
}

interface HistoryMessageLike {
  role?: unknown;
  message_role?: unknown;
  content?: unknown;
  message?: unknown;
  thinking?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
}

function extractRole(
  message: HistoryMessageLike,
): "user" | "assistant" | "system" | null {
  const role = message.role ?? message.message_role;
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return null;
}

function extractContent(message: HistoryMessageLike): string | null {
  if (typeof message.content === "string") {
    return message.content;
  }

  // Handle structured array content from Papr Memory
  // e.g. [{type: "thinking", thinking: "..."}, {type: "text", text: "..."}, {type: "tool_use", ...}]
  if (Array.isArray(message.content)) {
    const textParts = (message.content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (textParts.length > 0) {
      return textParts.join("");
    }
    // Array with no text parts (e.g. only tool_use) — return empty string so
    // the message isn't skipped; tool calls will be extracted separately
    return "";
  }

  if (
    typeof message.content === "object" &&
    message.content !== null &&
    "text" in message.content
  ) {
    const contentObj = message.content as { text?: unknown };
    if (typeof contentObj.text === "string") {
      return contentObj.text;
    }
  }

  if (typeof message.message === "string") {
    return message.message;
  }

  return null;
}

function extractToolCalls(message: HistoryMessageLike): ToolCallLike[] {
  const candidate = message.toolCalls ?? message.tool_calls;
  if (Array.isArray(candidate)) {
    return candidate.filter(
      (entry): entry is ToolCallLike =>
        typeof entry === "object" && entry !== null,
    );
  }

  // Extract tool calls from Papr structured content array
  // Format: [{type: "tool_use", id: "...", name: "...", input: {...}}]
  if (Array.isArray(message.content)) {
    const toolUseParts = (message.content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "tool_use")
      .map((p) => ({
        id: p.id as string,
        name: p.name as string,
        args: p.input ?? {},
      }));
    if (toolUseParts.length > 0) {
      return toolUseParts;
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Text-only formatting (used for summaries and non-model contexts)
// ---------------------------------------------------------------------------

/**
 * Format a message's content as a plain string.
 * Used for summary generation and non-model contexts where structured
 * tool call format is not needed.
 *
 * NOTE: This intentionally does NOT include [tool_activity] blocks.
 * Tool calls are summarized briefly to avoid training the model to
 * generate fake tool call text.
 */
export function formatMessageContentForModel(
  message: HistoryMessageLike,
): string | null {
  const content = extractContent(message);
  if (!content) {
    return null;
  }

  const parts: string[] = [content];

  const toolCalls = extractToolCalls(message);
  if (toolCalls.length > 0) {
    const toolNames = toolCalls.map((tc) =>
      typeof tc.name === "string" ? tc.name : "unknown",
    );
    parts.push(`\n(Used tools: ${toolNames.join(", ")})`);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// AI SDK structured message formatting
// ---------------------------------------------------------------------------

/**
 * Convert stored history messages to AI SDK compatible format.
 *
 * For assistant messages with tool calls, produces:
 * 1. { role: "assistant", content: [TextPart, ...ToolCallParts] }
 * 2. { role: "tool", content: [ToolResultParts] }
 *
 * This ensures the model sees tool calls as structured API interactions
 * (not text to imitate), which prevents tool call hallucination.
 */
export function formatHistoryMessagesForModel(
  history: unknown[],
): AIModelMessage[] {
  const messages: AIModelMessage[] = [];

  for (const entry of history) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const candidate = entry as HistoryMessageLike;
    const role = extractRole(candidate);
    const content = extractContent(candidate);

    if (!role || content === null) {
      continue;
    }

    if (role === "assistant") {
      const toolCalls = extractToolCalls(candidate);

      if (toolCalls.length > 0) {
        // Build structured assistant message with tool call content parts
        const contentParts: AssistantContent = [];

        // Add text content if present AND non-empty
        const trimmedContent = content.trim();
        if (trimmedContent) {
          contentParts.push({ type: "text", text: trimmedContent });
        }

        // Add tool call parts and collect results
        const toolResultParts: ToolContent = [];
        let toolIndex = 0;

        for (const tc of toolCalls) {
          // Anthropic requires tool_use IDs to match ^[a-zA-Z0-9_-]+$
          // IDs from PAPR history may contain dots or other invalid chars
          const rawId = typeof tc.id === "string" ? tc.id : `tc-hist-${toolIndex}`;
          const toolCallId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
          
          // Gemini (and Anthropic) require tool names to match ^[a-zA-Z0-9_-]+$
          // Sanitize tool names when loading from history to support provider switching
          const rawToolName = typeof tc.name === "string" ? tc.name : "unknown";
          const toolName = rawToolName.replace(/[^a-zA-Z0-9_-]/g, "_");

          contentParts.push({
            type: "tool-call",
            toolCallId,
            toolName,
            args: tc.args ?? {},
          });

          // Add matching tool result (truncate aggressively for history)
          // History strategy: Keep tool calls (what the agent did) but heavily truncate results
          // This preserves the "commands used" while minimizing context usage
          // If the tool call was persisted without a matching result
          // (e.g. stream interrupted, abort mid-flight, mismatched toolCallId),
          // emit an explicit marker so the model knows the result is missing
          // rather than seeing a silent empty string and assuming the tool
          // returned nothing.
          const hasResult = tc.result !== undefined && tc.result !== null;
          const resultValue: unknown = hasResult
            ? tc.result
            : `[Tool result not persisted — likely the stream was interrupted before this tool finished. Treat as unknown; do not assume success or failure. Re-invoke if you need the data.]`;
          const resultStr =
            typeof resultValue === "string"
              ? resultValue
              : JSON.stringify(resultValue);

          // AGGRESSIVE truncation for history: 100 tokens max (~400 chars)
          // This is much more aggressive than prepareStep's recency-based approach
          // Rationale: Historical tool results are less important than recent ones
          const HISTORY_MAX_TOKENS = 100;
          const HISTORY_MAX_CHARS = HISTORY_MAX_TOKENS * 4; // ~400 chars

          let truncatedResult: string;
          if (resultStr.length > HISTORY_MAX_CHARS) {
            const omitted = resultStr.length - HISTORY_MAX_CHARS;
            truncatedResult =
              resultStr.substring(0, HISTORY_MAX_CHARS) +
              `\n[... ${omitted} chars truncated. ` +
              `Tool: get_full_tool_result({ toolCallId: "${toolCallId}", toolName: "${toolName}" }) ` +
              `OR query: ~/.paprwork-v2/chats.db → messages.parts (JSONL)]`;
          } else {
            truncatedResult = resultStr;
          }

          toolResultParts.push({
            type: "tool-result",
            toolCallId,
            toolName, // Already sanitized above to match tool-call
            result: truncatedResult,
          });

          toolIndex++;
        }

        messages.push({ role: "assistant", content: contentParts });

        // Tool results message is REQUIRED by AI SDK before the next
        // user or assistant message
        if (toolResultParts.length > 0) {
          messages.push({ role: "tool", content: toolResultParts });
        }
      } else {
        // Simple text-only assistant message
        // Skip if content is empty
        if (content.trim()) {
          messages.push({ role: "assistant", content });
        }
      }
    } else if (role === "user") {
      messages.push({ role: "user", content });
    } else if (role === "system") {
      messages.push({ role: "system", content });
    }
  }

  return messages;
}

/**
 * Build the complete messages array for streamText / generateText.
 *
 * Combines:
 * 1. System prompt (if not already in history)
 * 2. Formatted history with proper tool call structure
 * 3. New user message (only if not already in history)
 */
export function buildModelMessages(
  history: unknown[],
  userMessage: string,
  systemPrompt: string,
  conversationSummary?: string,
): AIModelMessage[] {
  const messages = formatHistoryMessagesForModel(history);

  // Add system prompt if not already present
  if (systemPrompt && !messages.some((message) => message.role === "system")) {
    messages.unshift({
      role: "system",
      content: systemPrompt,
    });
  }

  // If we have a compressed summary, inject it as a user message AFTER system prompt but BEFORE recent history
  // This gives the model context about what happened earlier in the conversation
  if (conversationSummary) {
    // Find index after system prompt (should be index 1 if system exists, 0 if not)
    const systemIndex = messages.findIndex((m) => m.role === "system");
    const insertIndex = systemIndex >= 0 ? systemIndex + 1 : 0;
    
    messages.splice(insertIndex, 0, {
      role: "user",
      content: `[CONVERSATION CONTEXT - Earlier messages have been compressed for efficiency]

${conversationSummary}

[The messages below are the most recent conversation history]`,
    });
  }

  // Add the current user message at the end
  messages.push({
    role: "user",
    content: userMessage,
  });

  return messages;
}
