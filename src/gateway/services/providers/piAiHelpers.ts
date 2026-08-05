/**
 * Shared helpers for pi-ai provider integration (openai-codex, anthropic)
 */

import type { Message } from "@mariozechner/pi-ai";
import type { ZodTypeAny } from "zod";
import { extractToolResultText } from "../agent/historyFormatter.js";
import { getPiToolParameters } from "./piToolSchemaCache.js";

const ORPHAN_TOOL_RESULT_MARKER =
  "[Tool result not persisted — stream likely interrupted before this tool finished. Treat as unknown; re-invoke if needed.]";

function resolveToolResultErrorFlag(
  part: {
    result?: unknown;
    output?: { type: string; value: unknown };
  },
  resultText: string,
): boolean {
  if (part.result && typeof part.result === "object" && !Array.isArray(part.result)) {
    const resultObj = part.result as Record<string, unknown>;
    return resultObj.success === false || typeof resultObj.error === "string";
  }

  if (
    part.output?.type === "json" &&
    part.output.value &&
    typeof part.output.value === "object" &&
    !Array.isArray(part.output.value)
  ) {
    const valueObj = part.output.value as Record<string, unknown>;
    return valueObj.success === false || typeof valueObj.error === "string";
  }

  if (!resultText) {
    return false;
  }

  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    return parsed.success === false || typeof parsed.error === "string";
  } catch {
    return false;
  }
}

export interface PiContextInput {
  messages: unknown[];
  tools: Record<string, unknown>;
  apiId: string;
  providerId: string;
  modelId?: string;
  nativeTools?: Array<{ type: string; name?: string; max_uses?: number }>; // Native provider tools (web search, etc.)
}

/**
 * Convert our AIModelMessage format to pi-ai Context messages
 */
export function buildPiContext(input: PiContextInput): {
  systemPrompt?: string;
  messages: Message[];
  tools?: any[]; // Allow mixed tool formats (custom + native)
} {
  const { messages, tools, apiId, providerId, modelId = "", nativeTools } = input;

  const piMessages: Array<{ role: string; [k: string]: unknown }> = [];
  const now = Date.now();

  for (const msg of messages as any[]) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        piMessages.push({ role: "user", content: msg.content, timestamp: now });
        continue;
      }

      if (Array.isArray(msg.content)) {
        type PiUserPart =
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string };
        const piContent: PiUserPart[] = [];
        for (const part of msg.content as Array<{
          type?: string;
          text?: string;
          image?: string;
          mediaType?: string;
        }>) {
          if (part.type === "text") {
            piContent.push({ type: "text", text: part.text ?? "" });
          } else if (part.type === "image" && typeof part.image === "string") {
            piContent.push({
              type: "image",
              data: part.image,
              mimeType: part.mediaType ?? "image/png",
            });
          }
        }
        if (piContent.length === 1 && piContent[0].type === "text") {
          piMessages.push({
            role: "user",
            content: piContent[0].text,
            timestamp: now,
          });
        } else if (piContent.length > 0) {
          piMessages.push({ role: "user", content: piContent, timestamp: now });
        } else {
          piMessages.push({ role: "user", content: "", timestamp: now });
        }
        continue;
      }

      piMessages.push({ role: "user", content: "", timestamp: now });
      continue;
    }

    if (msg.role === "assistant") {
      type ContentPart =
        | { type: "text"; text: string }
        | {
            type: "toolCall";
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          };
      let content: ContentPart[] = [];
      if (typeof msg.content === "string") {
        content = [{ type: "text", text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === "text")
            content.push({ type: "text", text: part.text ?? "" });
          else if (part.type === "tool-call") {
            const rawArgs =
              part.input !== undefined
                ? part.input
                : part.args !== undefined
                  ? part.args
                  : {};
            content.push({
              type: "toolCall",
              id: part.toolCallId ?? "",
              // Tool names are already sanitized in historyFormatter, just pass through
              name: part.toolName ?? "",
              arguments:
                typeof rawArgs === "object" && rawArgs !== null
                  ? (rawArgs as Record<string, unknown>)
                  : {},
            });
          }
        }
      }
      piMessages.push({
        role: "assistant",
        content,
        api: apiId,
        provider: providerId,
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      });
      continue;
    }

    if (msg.role === "tool") {
      const results = Array.isArray(msg.content) ? msg.content : [];
      for (const r of results as any[]) {
        // Accept:
        //  - AI SDK 6 tool-result: { output: { type, value } } (from historyFormatter)
        //  - Legacy AI-SDK tool-result: { result: <any> }
        //  - Pi-ai round-trip: { text: "..." }
        //  - Missing result (interrupted stream): explicit marker, never silent empty string
        const directText =
          typeof (r as any).text === "string" ? (r as any).text : undefined;
        const extractedText = extractToolResultText(r);
        const text =
          extractedText ||
          directText ||
          ORPHAN_TOOL_RESULT_MARKER;
        const hasError = resolveToolResultErrorFlag(r, extractedText);
        piMessages.push({
          role: "toolResult",
          toolCallId: r.toolCallId ?? "",
          toolName: r.toolName ?? r.name ?? "",
          content: [{ type: "text" as const, text }],
          isError: hasError,
          timestamp: now,
        });
      }
    }
  }

  const systemMsg = messages.find((m: any) => (m as any).role === "system");
  const systemPrompt =
    typeof (systemMsg as any)?.content === "string"
      ? (systemMsg as any).content
      : undefined;

  const piTools = Object.entries(tools).map(([toolKey, tool]) => {
    const entry = tool as {
      id?: string;
      description?: string;
      inputSchema?: ZodTypeAny;
    };
    const toolId = entry.id || toolKey;
    const parameters = getPiToolParameters(toolId, entry.inputSchema);
    return {
      name: toolId,
      description: entry.description || "",
      parameters,
    };
  });

  console.log(`[buildPiContext] Converted ${piTools.length} tool schemas`);

  // Combine custom tools with native tools (web search, etc.)
  // NOTE: Native tools have different structure { type, name, max_uses } vs custom tools { name, description, parameters }
  // We append them as-is and let pi-ai handle the different formats
  const allTools: any[] = [...piTools];
  if (nativeTools && nativeTools.length > 0) {
    allTools.push(...nativeTools);
    console.log(`[buildPiContext] Added ${nativeTools.length} native tools:`, nativeTools.map(t => t.type || t.name).join(', '));
  }

  return {
    systemPrompt,
    messages: piMessages as unknown as Message[],
    tools: allTools.length > 0 ? allTools : undefined,
  };
}
