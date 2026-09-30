/**
 * What the tool block actually costs on the wire.
 *
 * The previous estimate was `JSON.stringify(tools).length / 4`. That measures
 * the wrong object: a Zod schema's shape lives in `_def`, so stringifying a
 * tool walks an internal tree the provider never sees, while the provider
 * receives the compact JSON Schema. Measured across all 152 registered tools
 * the old figure reads 88,477 tokens against 40,220 by this estimator — 2.20x
 * over — and worst on the tools with the deepest `_def` trees (`update_schema`
 * read as 12,750 against 898, over 14x).
 *
 * That estimate is *subtracted* in `computeHistoryTokenBudget`, so over-stating
 * it withholds history. At the 200K cap the correction takes the allowance from
 * 14,857 to 63,114 tokens; at 400K from 123,523 to 171,780, where
 * `DEFAULT_HISTORY_TOKEN_CAP` then holds it to 128,000.
 *
 * `chars / 4` is kept as the tokens-per-char rule. Measured on the real wire
 * payload with `cl100k_base` the ratio is 4.176 chars/token, so dividing by 4
 * over-states by ~4.4% — the safe direction for a value that is subtracted from
 * a budget. Reproduce with `npm run measure:tool-schema-cost`.
 */

import { z } from "zod";

/**
 * Measured chars-per-token for tool-schema text (JSON Schema + descriptions).
 * Documented rather than used: the divisor below is deliberately 4, not this,
 * so the estimate errs toward reserving more room than the block needs.
 */
export const MEASURED_TOOL_SCHEMA_CHARS_PER_TOKEN = 4.176;

const CHARS_PER_TOKEN = 4;

/** The payload shape a provider receives for one tool. */
export interface ToolWirePayload {
  name: string;
  description: string;
  input_schema: unknown;
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type UnknownTool = any;

/**
 * Build the payload the provider is actually sent for one tool.
 *
 * A schema that fails conversion falls back to a marker object rather than
 * throwing: a single exotic schema must not take down the whole estimate, and
 * an under-count is visible in the log line rather than silent.
 */
export function toolWirePayload(id: string, tool: UnknownTool): ToolWirePayload {
  const name = (tool?.id as string | undefined) ?? id;
  const description = (tool?.description as string | undefined) ?? "";

  let inputSchema: unknown = {};
  const schema = tool?.inputSchema;
  if (schema && typeof schema === "object") {
    try {
      // Anything already plain JSON Schema passes through untouched; a Zod
      // schema is converted the way the SDK converts it before sending.
      const isZod = "_def" in schema || "_zod" in schema;
      inputSchema = isZod
        ? z.toJSONSchema(schema as z.ZodType, {
            io: "input",
            unrepresentable: "any",
          })
        : schema;
    } catch {
      inputSchema = { type: "object" };
    }
  }

  return { name, description, input_schema: inputSchema };
}

/**
 * Character count of the tool block as the provider receives it.
 *
 * Separate from the token estimate so the ratio can be re-measured without
 * rebuilding every payload.
 */
export function toolBlockChars(tools: Record<string, UnknownTool>): number {
  let chars = 0;
  for (const [id, tool] of Object.entries(tools)) {
    chars += JSON.stringify(toolWirePayload(id, tool)).length;
  }
  return chars;
}

/**
 * Token estimate for the tool block, memoized on the set of tool names.
 *
 * The registry is effectively constant within a process, so building 152 JSON
 * Schemas once per turn is waste. Keyed on the sorted name list because that is
 * what changes when deferral narrows the set — two different selections must
 * not share an entry.
 */
const blockTokenCache = new Map<string, number>();

export function estimateToolBlockTokens(
  tools: Record<string, UnknownTool>,
): number {
  const key = Object.keys(tools).sort().join(",");
  const cached = blockTokenCache.get(key);
  if (cached !== undefined) return cached;

  const tokens = Math.ceil(toolBlockChars(tools) / CHARS_PER_TOKEN);
  blockTokenCache.set(key, tokens);
  return tokens;
}

/** Per-tool token cost, for deferral selection and for the context panel. */
export function estimateToolTokens(id: string, tool: UnknownTool): number {
  return Math.ceil(
    JSON.stringify(toolWirePayload(id, tool)).length / CHARS_PER_TOKEN,
  );
}

/** Test seam: the memo would otherwise leak between cases. */
export function __resetToolBlockTokenCache(): void {
  blockTokenCache.clear();
}
