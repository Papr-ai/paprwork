/**
 * History Formatter - Converts stored messages to AI SDK compatible format
 *
 * CRITICAL: Tool calls must be represented as structured content parts,
 * NOT as plain text. If tool calls are serialized as text (e.g. "[tool_activity]"),
 * the model learns to generate fake tool call text instead of actually invoking tools.
 *
 * AI SDK 6 expected message format for tool calls:
 * 1. { role: "assistant", content: [{ type: "text", ... }, { type: "tool-call", input: ... }] }
 * 2. { role: "tool", content: [{ type: "tool-result", output: { type: "text"|"json", value: ... } }] }
 *
 * CONTEXT MANAGEMENT:
 * - Tool results in storage can be up to 100KB each (MAX_TOOL_RESULT_LENGTH)
 * - When loading history into LLM context, tool results use category-based limits
 *   (see toolResultTruncation.ts and docs/TOOL_RESULT_TRUNCATION_STRATEGY.md)
 * - Bash/API results in the last 4 user turns stay full (see toolResultTruncation.ts)
 * - Full results remain in storage for UI display and debugging
 * - This prevents context length exceeded errors during long tool-heavy conversations
 */

import { truncateHistoryToolResult } from "./toolResultTruncation.js";

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
  input: unknown;
}

/** AI SDK 6 tool-result output (replaces legacy `result` string field). */
type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: unknown };

interface ToolResultContentPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
}

function toToolResultOutput(value: unknown): ToolResultOutput {
  if (typeof value === "string") {
    return { type: "text", value };
  }
  return { type: "json", value };
}

/** Safely stringify tool result values for previews (handles AI SDK 6 `output` field). */
export function extractToolResultText(part: {
  result?: unknown;
  output?: ToolResultOutput;
}): string {
  if (part.output) {
    if (part.output.type === "text") {
      return part.output.value;
    }
    try {
      return JSON.stringify(part.output.value);
    } catch {
      return String(part.output.value);
    }
  }

  if (typeof part.result === "string") {
    return part.result;
  }
  if (part.result === undefined || part.result === null) {
    return "";
  }
  try {
    return JSON.stringify(part.result);
  } catch {
    return String(part.result);
  }
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

const THINKING_FALLBACK_MAX_CHARS = 4000;

function extractThinkingText(message: HistoryMessageLike): string | null {
  if (typeof message.thinking === "string" && message.thinking.trim()) {
    const trimmed = message.thinking.trim();
    if (trimmed.length <= THINKING_FALLBACK_MAX_CHARS) {
      return trimmed;
    }
    return (
      trimmed.substring(0, THINKING_FALLBACK_MAX_CHARS) +
      `\n[... ${trimmed.length - THINKING_FALLBACK_MAX_CHARS} chars of thinking truncated]`
    );
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
  const historyLike = history.filter(
    (entry): entry is HistoryMessageLike =>
      typeof entry === "object" && entry !== null,
  );

  for (let entryIndex = 0; entryIndex < history.length; entryIndex += 1) {
    const entry = history[entryIndex];
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

        // Add text content if present AND non-empty (fall back to thinking when text empty)
        const trimmedContent = content.trim();
        const thinkingText = extractThinkingText(candidate);
        const assistantText = trimmedContent || thinkingText;
        if (assistantText) {
          contentParts.push({ type: "text", text: assistantText });
        }

        // Add tool call parts and collect results
        const toolResultParts: ToolContent = [];
        let toolIndex = 0;

        for (const tc of toolCalls) {
          // Anthropic requires tool_use IDs to match ^[a-zA-Z0-9_-]+$
          // OpenAI requires IDs to be max 64 characters
          // IDs from PAPR history may contain dots or other invalid chars
          const rawId = typeof tc.id === "string" ? tc.id : `tc-hist-${toolIndex}`;
          const sanitizedId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
          // Truncate to 64 chars max for OpenAI compatibility
          const toolCallId = sanitizedId.length > 64 ? sanitizedId.substring(0, 64) : sanitizedId;
          const toolName = typeof tc.name === "string" ? tc.name : "unknown";

          contentParts.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input: tc.args ?? {},
          });

          // Add matching tool result (truncate aggressively for history)
          // History strategy: Keep tool calls (what the agent did) but heavily truncate results
          // This preserves the "commands used" while minimizing context usage
          //
          // If the tool call was persisted without a matching result
          // (e.g. stream interrupted, abort mid-flight, mismatched toolCallId),
          // emit an explicit marker so the model knows the result is missing
          // rather than seeing a silent empty string and assuming the tool
          // returned nothing. This matches the pre-regression behavior in
          // dist/historyFormatter.js.
          const hasResult = tc.result !== undefined && tc.result !== null;
          // Recognize orphan markers synthesized by streamOrchestrator when a
          // tool_use had no matching tool_result at stream end. Emit the
          // marker text directly (not JSON) so the model can read it cleanly.
          const isOrphan =
            hasResult &&
            typeof (tc as { result?: unknown }).result === "object" &&
            (tc as { result?: { __orphan?: boolean } }).result?.__orphan ===
              true;
          const resultValue = !hasResult
            ? "[Tool result not persisted — likely the stream was interrupted before this tool finished. Treat as unknown; do not assume success or failure. Re-invoke if you need the data.]"
            : isOrphan
              ? (tc as { result?: { message?: string } }).result?.message ??
                "[Tool result not persisted — likely the stream was interrupted before this tool finished.]"
              : (tc as { result?: unknown }).result;
          const resultStr =
            typeof resultValue === "string"
              ? resultValue
              : JSON.stringify(resultValue);

          const truncatedResult = truncateHistoryToolResult({
            toolName,
            toolCallId,
            args: tc.args ?? {},
            resultStr,
            history: historyLike,
            messageIndex: entryIndex,
            isOrphan,
          });

          toolResultParts.push({
            type: "tool-result",
            toolCallId,
            toolName,
            output: toToolResultOutput(truncatedResult),
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
        // Simple text-only assistant message (use thinking when visible text empty)
        const trimmedContent = content.trim();
        const thinkingText = extractThinkingText(candidate);
        const assistantText = trimmedContent || thinkingText;
        if (assistantText) {
          messages.push({ role: "assistant", content: assistantText });
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
  memoryContextBlocks?: string[],
  activePlansContext?: string,
  focusContext?: string,
): AIModelMessage[] {
  const messages = formatHistoryMessagesForModel(history);

  // Add system prompt if not already present
  if (systemPrompt && !messages.some((message) => message.role === "system")) {
    messages.unshift({
      role: "system",
      content: systemPrompt,
    });
  }

  let contextInsertIndex = messages.findIndex((m) => m.role === "system");
  contextInsertIndex = contextInsertIndex >= 0 ? contextInsertIndex + 1 : 0;

  // Memory bootstrap first (stable for the session inject turn) — before summary
  if (memoryContextBlocks && memoryContextBlocks.length > 0) {
    for (const block of memoryContextBlocks) {
      messages.splice(contextInsertIndex, 0, {
        role: "user",
        content: block,
      });
      contextInsertIndex += 1;
    }
  }

  // Compressed summary after bootstrap, before recent history
  if (conversationSummary) {
    messages.splice(contextInsertIndex, 0, {
      role: "user",
      content: `[CONVERSATION CONTEXT - Earlier messages have been compressed for efficiency]

${conversationSummary}

[The messages below are the most recent conversation history]`,
    });
    contextInsertIndex += 1;
  }

  // Active plans after history, before the current user turn (volatile — keeps system/summary cache stable)
  const lastMessage = messages[messages.length - 1];
  const isDuplicate =
    lastMessage &&
    lastMessage.role === "user" &&
    lastMessage.content === userMessage;

  if (activePlansContext) {
    const insertAt = isDuplicate ? messages.length - 1 : messages.length;
    messages.splice(insertAt, 0, {
      role: "user",
      content: activePlansContext,
    });
  }

  // UI focus + recent edits — volatile, after plans, before current user turn
  if (focusContext) {
    const insertAt = isDuplicate ? messages.length - 1 : messages.length;
    messages.splice(insertAt, 0, {
      role: "user",
      content: focusContext,
    });
  }

  // Add the current user message at the end (only if not already present)
  if (isDuplicate) {
    console.log(`[historyFormatter] Skipping duplicate user message (already in history)`);
  } else {
    messages.push({
      role: "user",
      content: userMessage,
    });
  }

  return messages;
}
