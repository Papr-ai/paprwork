/**
 * Size-bounded payloads for PAPR cloud sync.
 *
 * Parse Server rejects bodies over ~100KB. Memory server adds wrapper overhead,
 * so we target 80KB on the client JSON body and shrink progressively when needed.
 * Full fidelity stays in local SQLite — sync is for backup and summarization.
 */

import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";
import type { StoredMessage } from "./IStorageProvider.js";

/** Client budget — leave headroom for memory server → Parse wrapper. */
export const PAPR_SYNC_MAX_BYTES = 80_000;

const TRUNC_MARKER = "\n[... truncated for cloud sync ...]";

export type PaprContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type PaprSyncCustomMetadata = Record<
  string,
  string | number | boolean | Array<string>
>;

export interface PaprMessageStoreBody {
  content: string | PaprContentBlock[];
  role: "user" | "assistant";
  sessionId: string;
  process_messages: boolean;
  metadata: {
    conversationId: string;
    createdAt: string;
    role: "user" | "assistant";
    customMetadata: PaprSyncCustomMetadata;
  };
  /** Real Papr _User.objectId — see memoryAcl.ts for why this is not external_user_id. */
  user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
}

interface PaprSyncBudget {
  maxTextChars: number;
  maxToolArgsChars: number;
  maxToolResultChars: number;
  includeThinking: boolean;
  includeToolInputs: boolean;
  includeToolResults: boolean;
}

const DEFAULT_BUDGET: PaprSyncBudget = {
  maxTextChars: 8_000,
  maxToolArgsChars: 500,
  maxToolResultChars: 500,
  includeThinking: false,
  includeToolInputs: true,
  includeToolResults: true,
};

const REDUCTION_STEPS: PaprSyncBudget[] = [
  DEFAULT_BUDGET,
  { ...DEFAULT_BUDGET, maxToolArgsChars: 200 },
  {
    ...DEFAULT_BUDGET,
    maxToolArgsChars: 0,
    includeToolInputs: false,
  },
  {
    ...DEFAULT_BUDGET,
    maxToolArgsChars: 0,
    includeToolInputs: false,
    maxToolResultChars: 200,
  },
  {
    ...DEFAULT_BUDGET,
    maxToolArgsChars: 0,
    includeToolInputs: false,
    includeToolResults: false,
  },
  {
    maxTextChars: 2_000,
    maxToolArgsChars: 0,
    maxToolResultChars: 0,
    includeThinking: false,
    includeToolInputs: false,
    includeToolResults: false,
  },
];

export function measurePaprStoreBodyBytes(body: PaprMessageStoreBody): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

export function truncateStringForPaprSync(
  value: string,
  maxChars: number,
): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNC_MARKER.length) {
    return value.substring(0, maxChars);
  }
  return (
    value.substring(0, maxChars - TRUNC_MARKER.length) + TRUNC_MARKER
  );
}

function truncateToolArgsForPaprSync(
  args: Record<string, unknown> | undefined,
  maxChars: number,
): Record<string, unknown> | undefined {
  if (!args || maxChars <= 0) return undefined;
  const serialized = JSON.stringify(args);
  if (serialized.length <= maxChars) return args;
  return {
    _truncatedPreview: truncateStringForPaprSync(serialized, maxChars),
  };
}

export function buildPaprSyncCustomMetadata(
  message: StoredMessage,
): PaprSyncCustomMetadata {
  const customMetadata: PaprSyncCustomMetadata = {
    sourceAgentId: message.source_agent_id || "main-agent",
    sourceAgentName: message.source_agent_name || "Paprwork Assistant",
    model: message.model || "unknown",
  };

  if (message.toolCalls && message.toolCalls.length > 0) {
    customMetadata.toolsUsed = message.toolCalls.map((tc) => tc.name);
    customMetadata.toolCallsCount = message.toolCalls.length;
  }

  if (message.thinking) {
    customMetadata.hasThinking = true;
    customMetadata.thinkingLength = message.thinking.length;
  }

  if (message.prompt_tokens) {
    customMetadata.promptTokens = message.prompt_tokens;
    customMetadata.completionTokens = message.completion_tokens ?? 0;
    customMetadata.totalTokens = message.total_tokens ?? 0;
  }

  if (message.error) {
    customMetadata.hasError = true;
  }

  if (message.incomplete) {
    customMetadata.incomplete = true;
  }

  return customMetadata;
}

export function buildPaprSyncContent(
  message: Pick<StoredMessage, "role" | "content" | "thinking" | "toolCalls">,
  budget: PaprSyncBudget,
): string | PaprContentBlock[] {
  const toolCalls = message.toolCalls ?? [];

  if (message.role === "assistant" && toolCalls.length > 0) {
    const contentBlocks: PaprContentBlock[] = [];

    if (message.content) {
      contentBlocks.push({
        type: "text",
        text: truncateStringForPaprSync(message.content, budget.maxTextChars),
      });
    }

    if (budget.includeThinking && message.thinking) {
      contentBlocks.push({
        type: "thinking",
        thinking: truncateStringForPaprSync(
          message.thinking,
          budget.maxTextChars,
        ),
      });
    }

    for (const tc of toolCalls) {
      const toolUse: PaprContentBlock = {
        type: "tool_use",
        id: tc.id,
        name: tc.name,
      };

      if (budget.includeToolInputs) {
        const input = truncateToolArgsForPaprSync(
          tc.args as Record<string, unknown>,
          budget.maxToolArgsChars,
        );
        if (input) {
          (toolUse as { input: Record<string, unknown> }).input = input;
        }
      }

      contentBlocks.push(toolUse);

      if (budget.includeToolResults && tc.result != null) {
        contentBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: truncateStringForPaprSync(
            String(tc.result),
            budget.maxToolResultChars,
          ),
        });
      }
    }

    return contentBlocks;
  }

  return truncateStringForPaprSync(message.content, budget.maxTextChars);
}

function buildPaprSyncSummaryFallback(message: StoredMessage): string {
  const toolNames = message.toolCalls?.map((tc) => tc.name) ?? [];
  const uniqueTools = [...new Set(toolNames)];
  const preview = message.content
    ? truncateStringForPaprSync(message.content, 2_000)
    : "";
  const toolLine =
    toolNames.length > 0
      ? `\n[${toolNames.length} tool calls: ${uniqueTools.join(", ")}]`
      : "";

  return `${preview}${toolLine}\n[Full message stored locally — cloud sync truncated due to size]`;
}

/** Paprwork isolated job runs use session ids like ``job:{jobId}:{runId}``. */
export function isJobSessionChatId(chatId: string): boolean {
  return chatId.startsWith("job:");
}

export {
  extractJobIdFromChatId,
  JOB_SESSION_PROCESS_INTERVAL_MS,
  resetJobSessionProcessThrottleForTests,
  shouldEnableJobSessionProcessMessages,
} from "./jobSessionProcessThrottle.js";

import { shouldEnableJobSessionProcessMessages } from "./jobSessionProcessThrottle.js";

function resolveProcessMessages(
  chatId: string,
  processMessages?: boolean,
): boolean {
  if (processMessages !== undefined) {
    return processMessages;
  }
  if (!isJobSessionChatId(chatId)) {
    return true;
  }
  // Occasional job summaries — throttled to avoid cross-session analysis storms.
  return shouldEnableJobSessionProcessMessages(chatId);
}

function assembleStoreBody(
  chatId: string,
  message: StoredMessage,
  content: string | PaprContentBlock[],
  customMetadata: PaprSyncCustomMetadata,
  scope?: {
    userId?: string;
    namespaceId?: string;
    policy?: MemoryAddPolicy;
  },
  processMessages?: boolean,
): PaprMessageStoreBody {
  const body: PaprMessageStoreBody = {
    content,
    role: message.role,
    sessionId: chatId,
    process_messages: resolveProcessMessages(chatId, processMessages),
    metadata: {
      conversationId: chatId,
      createdAt: message.timestamp,
      role: message.role,
      customMetadata,
    },
  };

  if (scope?.userId) {
    body.user_id = scope.userId;
  }
  if (scope?.namespaceId) {
    body.namespace_id = scope.namespaceId;
  }
  if (scope?.policy) {
    body.policy = scope.policy;
  }

  return body;
}

export function buildPaprSyncStoreBody(input: {
  chatId: string;
  message: StoredMessage;
  userId?: string;
  namespaceId?: string;
  policy?: MemoryAddPolicy;
  maxBytes?: number;
  /** Override auto job-session detection when callers need explicit control. */
  processMessages?: boolean;
}): PaprMessageStoreBody {
  const maxBytes = input.maxBytes ?? PAPR_SYNC_MAX_BYTES;
  const customMetadata = buildPaprSyncCustomMetadata(input.message);
  const scope = {
    userId: input.userId,
    namespaceId: input.namespaceId,
    policy: input.policy,
  };

  for (let i = 0; i < REDUCTION_STEPS.length; i++) {
    const budget = REDUCTION_STEPS[i]!;
    const content = buildPaprSyncContent(input.message, budget);
    const body = assembleStoreBody(
      input.chatId,
      input.message,
      content,
      customMetadata,
      scope,
      input.processMessages,
    );

    if (measurePaprStoreBodyBytes(body) <= maxBytes) {
      if (i > 0) {
        customMetadata.syncPayloadTruncated = true;
      }
      return body;
    }
  }

  customMetadata.syncPayloadTruncated = true;
  return assembleStoreBody(
    input.chatId,
    input.message,
    buildPaprSyncSummaryFallback(input.message),
    customMetadata,
    scope,
    input.processMessages,
  );
}
