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

type JsonObject = Record<string, unknown>;
const isObj = (v: unknown): v is JsonObject => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Providers (Anthropic: "input_schema.type: Field required") need every tool's
 * input schema to be `{ type: "object", properties }` at the top level. Some MCP
 * servers (e.g. Amplitude's use_amplitude_chart_monitors) put all parameters in a
 * top-level anyOf/oneOf with an empty top-level `properties`. Zod turns that into
 * a schema with no `type`, and one such tool 400s the whole request.
 *
 * Flatten it: merge every branch's properties up to the top level (so the model
 * still sees every parameter), keep only `required` fields common to all branches,
 * and drop the combinator. The server still enforces the exact "one of" rules.
 */
export function flattenTopLevelUnion(schema: JsonObject): JsonObject {
  const flat: JsonObject = { ...schema, type: "object" };
  const branches: JsonObject[] = [];
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = flat[k];
    if (Array.isArray(list)) branches.push(...list.filter(isObj));
  }
  for (const k of ["anyOf", "oneOf", "allOf", "not", "if", "then", "else"]) delete flat[k];
  if (branches.length === 0) return flat;

  const props: JsonObject = isObj(flat.properties) ? { ...flat.properties } : {};
  for (const b of branches) {
    if (!isObj(b.properties)) continue;
    for (const [name, def] of Object.entries(b.properties)) if (!(name in props)) props[name] = def;
  }
  const reqOf = (b: JsonObject) => (Array.isArray(b.required) ? (b.required as string[]) : []);
  const common = branches.map(reqOf).reduce((a, r) => a.filter((n) => r.includes(n)));
  const required = [...new Set([...reqOf(flat), ...common])].filter((n) => n in props);
  flat.properties = props;
  if (required.length > 0) flat.required = required;
  else delete flat.required;
  delete flat.additionalProperties; // branches said false; the merged shape is a union, so don't forbid.
  return flat;
}

export function mcpInputSchemaToZod(schema: JsonObject | undefined): z.ZodType {
  if (!isObj(schema)) return z.looseObject({});
  try {
    const zod = z.fromJSONSchema(flattenTopLevelUnion(schema) as Parameters<typeof z.fromJSONSchema>[0]);
    const wire = z.toJSONSchema(zod, { io: "input", unrepresentable: "any" }) as { type?: unknown };
    return wire.type === "object" ? zod : z.looseObject({});
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
    inputSchema: mcpInputSchemaToZod(tool.inputSchema),
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
