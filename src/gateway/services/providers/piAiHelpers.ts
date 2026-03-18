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
}

/**
 * Convert our AIModelMessage format to pi-ai Context messages
 */
export function buildPiContext(input: PiContextInput): {
  systemPrompt?: string;
  messages: Message[];
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
} {
  const { messages, tools, apiId, providerId, modelId = "" } = input;

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
        const text =
          typeof r.result === "string"
            ? r.result
            : JSON.stringify(r.result ?? "");
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

  return {
    systemPrompt,
    messages: piMessages as unknown as Message[],
    tools: piTools.length > 0 ? piTools : undefined,
  };
}
