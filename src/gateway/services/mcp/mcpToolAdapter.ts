/**
 * Turn remote MCP tools into Mastra tools the agent registry can hold.
 *
 * Ids are `<serverId>__<toolName>` so they never collide with built-ins and
 * `find_tools("linear")` surfaces a whole server. They are NOT in the measured
 * core set, so tool deferral withholds them unless the user's message names
 * them — 40 Linear schemas never ride in the cached prefix by default.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export type McpToolCaller = (
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<McpCallResult>;

export interface McpCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
}

/** Provider tool names allow [a-zA-Z0-9_-]{1,64}. */
export function mcpAgentToolId(serverId: string, toolName: string): string {
  const id = `${serverId.replace(/-/g, "_")}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return id.slice(0, 64);
}

const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_RESULT_CHARS = 60_000;

function toZod(schema: Record<string, unknown> | undefined): z.ZodType {
  if (!schema || typeof schema !== "object") return z.looseObject({});
  try {
    return z.fromJSONSchema({ type: "object", ...schema } as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // An exotic schema should not hide the tool — let the server validate.
    return z.looseObject({});
  }
}

/** Flatten MCP content blocks into text the model can read. */
export function formatMcpResult(result: McpCallResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && block.resource) parts.push(JSON.stringify(block.resource));
    else parts.push(`[${block.type} content omitted]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const text = parts.join("\n\n");
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated ${text.length - MAX_RESULT_CHARS} chars]`
    : text;
}

export function buildMcpAgentTool(
  server: { id: string; name: string },
  tool: McpToolDescriptor,
  call: McpToolCaller,
) {
  const id = mcpAgentToolId(server.id, tool.name);
  const desc = (tool.description ?? tool.annotations?.title ?? tool.name).trim();
  const hint = tool.annotations?.destructiveHint
    ? " (destructive: confirm with the user first)"
    : tool.annotations?.readOnlyHint
      ? " (read-only)"
      : "";
  const description = `[${server.name} via MCP]${hint} ${desc}`.slice(0, MAX_DESCRIPTION_CHARS);

  return createTool({
    id,
    description,
    inputSchema: toZod(tool.inputSchema),
    execute: async (inputData: unknown) => {
      const raw = (inputData as { context?: unknown })?.context ?? inputData;
      const args = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const started = performance.now();
      try {
        const result = await call(server.id, tool.name, args);
        return {
          success: !result.isError,
          data: formatMcpResult(result),
          ...(result.isError ? { error: formatMcpResult(result) || "MCP tool returned an error" } : {}),
          duration: performance.now() - started,
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          duration: performance.now() - started,
          timestamp: new Date().toISOString(),
        };
      }
    },
  });
}
