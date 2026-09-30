/**
 * Reaching a tool whose schema was not sent.
 *
 * Deferral withholds ~71% of the tool block, so the ~1.4% of calls that land
 * outside the measured core need a route back. That route cannot be "add the
 * tool and continue": the block sits in the cached prefix, so a mid-turn change
 * re-writes it. At opus-5 rates ($5/M input, so $6.25/M cache write, $0.50/M
 * read) one re-write of a 270K prefix is ~$1.69, against ~$0.49 saved by
 * withholding 28,670 tokens across 34 steps — a single unlock costs over three
 * times the whole turn's saving. See `toolDeferral.ts`.
 *
 * So the pair below is fixed in every request and the tool set never moves:
 *  - `find_tools` returns names and full schemas for deferred tools, so the
 *    model can read the arguments it needs.
 *  - `run_deferred_tool` executes one by name, validating against the real
 *    schema so a malformed call gets a usable error instead of a silent no-op.
 *
 * This is the same shape an MCP proxy uses, and it is why the saving survives:
 * discovery and dispatch cost message tokens, which are cheap and uncached,
 * rather than prefix tokens, which are neither.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { toolWirePayload } from "./toolSchemaTokens.js";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type UnknownTool = any;

/**
 * Schemas returned per `find_tools` call.
 *
 * Bounded because a schema averages ~265 tokens and the largest is over 2,000:
 * an unbounded match on a vague query would return more than the deferral saved
 * and land it in message context, where it is re-sent every later step.
 */
export const MAX_FIND_TOOLS_RESULTS = 6;

export interface DeferredToolAccessDeps {
  /** Ids withheld this turn. Read per call so a turn with none says so. */
  listDeferredToolIds: () => string[];
  /** Resolve a tool by id, deferred or not. */
  getTool: (id: string) => UnknownTool | undefined;
}

function scoreMatch(id: string, description: string, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const idLower = id.toLowerCase();
  if (idLower === q) return 100;
  if (idLower.includes(q)) return 50;

  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (terms.length === 0) return 1;

  let score = 0;
  const haystack = `${idLower} ${description.toLowerCase()}`;
  for (const t of terms) {
    if (idLower.includes(t)) score += 10;
    else if (haystack.includes(t)) score += 3;
  }
  return score;
}

export function createFindToolsTool(deps: DeferredToolAccessDeps): UnknownTool {
  return createTool({
    id: "find_tools",
    description:
      "Look up tools that are available but whose full schemas were not " +
      "included in this request, to keep the prompt small. Returns each " +
      "match's name, description and complete argument schema. Call this " +
      "when you need a capability you cannot see a tool for, then execute it " +
      "with run_deferred_tool. Tools you can already see do not need this.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "What you need to do, or a tool name. E.g. 'create a scheduled job', 'register_schema'.",
        ),
    }),
    execute: async (inputData: UnknownTool) => {
      const args = (inputData?.context ?? inputData ?? {}) as {
        query?: string;
      };
      const query = String(args.query ?? "");
      const deferred = deps.listDeferredToolIds();

      if (deferred.length === 0) {
        return {
          success: true,
          matches: [],
          message:
            "No tools are deferred in this request — every available tool's " +
            "schema is already visible to you.",
        };
      }

      const scored = deferred
        .map((id) => {
          const tool = deps.getTool(id);
          if (!tool) return null;
          const description = String(tool.description ?? "");
          return { id, tool, score: scoreMatch(id, description, query) };
        })
        .filter(
          (e): e is { id: string; tool: UnknownTool; score: number } =>
            e !== null && e.score > 0,
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FIND_TOOLS_RESULTS);

      if (scored.length === 0) {
        return {
          success: true,
          matches: [],
          deferred_tool_names: deferred,
          message:
            `No deferred tool matched "${query}". The full list of deferred ` +
            `tool names is included above — call find_tools again with one of ` +
            `them if it looks right.`,
        };
      }

      return {
        success: true,
        matches: scored.map((e) => toolWirePayload(e.id, e.tool)),
        message:
          `Execute any of these with run_deferred_tool({ tool_name, ` +
          `arguments }). Their schemas are given in full above.`,
      };
    },
  });
}

export function createRunDeferredTool(
  deps: DeferredToolAccessDeps,
): UnknownTool {
  return createTool({
    id: "run_deferred_tool",
    description:
      "Execute a tool whose schema was not included in this request. Use " +
      "find_tools first to read its argument schema. Do not use this for " +
      "tools you can already see — call those directly.",
    inputSchema: z.object({
      tool_name: z.string().min(1).describe("Exact tool name from find_tools."),
      arguments: z
        .record(z.string(), z.unknown())
        .describe("Arguments object matching that tool's schema."),
    }),
    execute: async (inputData: UnknownTool) => {
      const args = (inputData?.context ?? inputData ?? {}) as {
        tool_name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = String(args.tool_name ?? "");
      const toolArgs = args.arguments ?? {};

      const tool = deps.getTool(name);
      if (!tool) {
        const deferred = deps.listDeferredToolIds();
        return {
          success: false,
          error:
            `No tool named "${name}". Deferred tools in this request: ` +
            `${deferred.join(", ") || "(none)"}.`,
        };
      }

      // Validated here rather than left to the tool: a deferred tool's schema
      // was never shown to the model in the request, so a shape mistake is
      // likely and a schema-shaped error is what lets it self-correct.
      //
      // Dispatched FLAT, never as `{ context: args }`. The Mastra version in
      // use validates the payload it is handed against the tool's own schema
      // before the body runs, so a wrapped call fails on every required field
      // — `path: expected string, received undefined` with the real arguments
      // sitting one level down under `context`. That reads as the dispatcher
      // mangling the call rather than as a shape mismatch, and it silently
      // took out the 87 of 112 deferred tools that have a required argument,
      // `create_job` among them. Tools here accept both shapes because older
      // Mastra wrapped, so flat is the shape that works for all of them.
      if (tool.inputSchema && typeof tool.inputSchema.safeParse === "function") {
        const parsed = tool.inputSchema.safeParse(toolArgs);
        if (!parsed.success) {
          return {
            success: false,
            error: `Arguments did not match ${name}'s schema.`,
            issues: parsed.error?.issues ?? [],
            expected_schema: toolWirePayload(name, tool).input_schema,
          };
        }
        return await tool.execute(parsed.data);
      }

      return await tool.execute(toolArgs);
    },
  });
}
