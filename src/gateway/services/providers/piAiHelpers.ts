/**
 * Shared helpers for pi-ai provider integration (openai-codex, anthropic)
 */

import type { Message } from "@mariozechner/pi-ai";
import { zodToJsonSchema } from "zod-to-json-schema";

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
      const content = typeof msg.content === "string" ? msg.content : "";
      piMessages.push({ role: "user", content, timestamp: now });
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
          else if (part.type === "tool-call")
            content.push({
              type: "toolCall",
              id: part.toolCallId ?? "",
              // Tool names are already sanitized in historyFormatter, just pass through
              name: part.toolName ?? "",
              arguments: typeof part.args === "object" ? part.args : {},
            });
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
        // Accept three shapes:
        //  - AI-SDK tool-result: { result: <any> }
        //  - already pi-ai shape (round-tripped from storage): { text: "..." } / { type: "text", text: "..." }
        //  - missing result (interrupted stream): emit explicit marker, never a silent empty string
        const directText =
          typeof (r as any).text === "string" ? (r as any).text : undefined;
        const hasResult = r.result !== undefined && r.result !== null;
        const text = hasResult
          ? (typeof r.result === "string" ? r.result : JSON.stringify(r.result))
          : directText !== undefined
            ? directText
            : "[Tool result not persisted — stream likely interrupted before this tool finished. Treat as unknown; re-invoke if needed.]";
        const resultObj = r.result && typeof r.result === "object" ? r.result as Record<string, unknown> : null;
        const hasError = resultObj
          ? resultObj.success === false || typeof resultObj.error === "string"
          : false;
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

  const piTools = Object.entries(tools).map(
    ([toolKey, tool]: [string, any]) => {
      let parameters: Record<string, unknown> = {
        type: "object",
        properties: {},
      };
      if (tool.inputSchema) {
        try {
          parameters = zodToJsonSchema(tool.inputSchema, {
            target: "openApi3",
            $refStrategy: "none",
          }) as Record<string, unknown>;
        } catch (err) {
          console.warn(`Failed to convert schema for tool ${tool.id}:`, err);
        }
      }
      return {
        name: tool.id || toolKey,
        description: tool.description || "",
        parameters: parameters as any,
      };
    },
  );

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
