/**
 * Two interventions on step count, and the constraints that make them safe.
 *
 * **Deferral** withholds the schemas a turn will not call. The load-bearing
 * constraint is that the selection is fixed for the whole turn: the tool block
 * sits in the cached prefix, so one mid-turn change costs more in cache writes
 * than the whole turn's deferral saves. A deferred tool is therefore reached
 * through a dispatcher, never by adding it to the live set.
 *
 * **The width nudge** asks for batching at the point of decision, after a step
 * that used exactly one tool. It is a floor and never a ceiling: a fixed
 * tool-call budget is known to make models overrun their own limits, so the
 * wording must not cap total work.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFERRAL_ESCAPE_TOOL_IDS,
  MEASURED_CORE_TOOL_IDS,
  MIN_DEFERRAL_SAVING_TOKENS,
  selectTurnToolIds,
  type DeferrableTool,
} from "../src/gateway/services/agent/toolDeferral.js";
import {
  MAX_WIDTH_NUDGES_PER_TURN,
  WIDTH_NUDGE_STEP_HEADROOM,
  WIDTH_TARGET_DESCENT_STEP,
  resolveParallelWidthNudge,
} from "../src/gateway/services/agent/parallelWidthNudge.js";
import {
  MAX_FIND_TOOLS_RESULTS,
  createFindToolsTool,
  createRunDeferredTool,
} from "../src/gateway/services/agent/deferredToolAccess.js";
import { getPiToolParameters } from "../src/gateway/services/providers/piToolSchemaCache.js";

const REPO = path.resolve(__dirname, "..");

function readSource(rel: string): string {
  return readFileSync(path.join(REPO, rel), "utf8");
}

/** Comments name the symbols they explain, so a raw search finds its own prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

function deferrable(id: string, tokens: number, description = ""): DeferrableTool {
  return { id, description, tokens };
}

/** Enough bulk outside the core set to clear the saving threshold. */
function bulkTools(count: number, tokens = 1_000): DeferrableTool[] {
  return Array.from({ length: count }, (_, i) =>
    deferrable(`obscure_capability_${i}`, tokens, "an unrelated capability"),
  );
}

describe("turn tool selection", () => {
  it("always sends the measured core tools", () => {
    const tools = [
      ...MEASURED_CORE_TOOL_IDS.map((id) => deferrable(id, 200)),
      ...bulkTools(30),
    ];
    const sel = selectTurnToolIds({ tools, requestText: "hello" });

    expect(sel.enabled).toBe(true);
    for (const id of MEASURED_CORE_TOOL_IDS) {
      expect(sel.activeToolIds).toContain(id);
    }
  });

  it("always sends the dispatcher pair, or deferred tools are unreachable", () => {
    const tools = [
      ...DEFERRAL_ESCAPE_TOOL_IDS.map((id) => deferrable(id, 300)),
      ...bulkTools(30),
    ];
    const sel = selectTurnToolIds({ tools, requestText: "hello" });

    for (const id of DEFERRAL_ESCAPE_TOOL_IDS) {
      expect(sel.activeToolIds).toContain(id);
      expect(sel.deferredToolIds).not.toContain(id);
    }
  });

  it("pulls in a tool the request names", () => {
    const tools = [
      deferrable("register_schema", 900, "Register a memory graph schema"),
      ...bulkTools(30),
    ];
    const sel = selectTurnToolIds({
      tools,
      requestText: "please register_schema for the books graph",
    });

    expect(sel.activeToolIds).toContain("register_schema");
  });

  it("matches on the id, not just an exact word", () => {
    const tools = [
      deferrable("delete_schema", 800, "Archive a schema"),
      ...bulkTools(30),
    ];
    const sel = selectTurnToolIds({
      tools,
      requestText: "I want to delete the old schema",
    });
    expect(sel.activeToolIds).toContain("delete_schema");
  });

  it("does not let a common word select the whole registry", () => {
    // Without a stopword list, "please" or "tool" in a request matches most
    // descriptions and defers nothing, which is the failure mode that makes
    // request matching worthless.
    const tools = bulkTools(40).map((t) => ({
      ...t,
      description: "please use this tool to return a value",
    }));
    const sel = selectTurnToolIds({
      tools,
      requestText: "please use a tool to return a value",
    });

    expect(sel.enabled).toBe(true);
    expect(sel.deferredToolIds.length).toBeGreaterThan(30);
  });

  it("sends everything when the saving would not pay for the machinery", () => {
    // Two small tools outside the core set: deferring them buys back less than
    // the dispatcher's own description costs.
    const tools = [
      ...MEASURED_CORE_TOOL_IDS.slice(0, 5).map((id) => deferrable(id, 200)),
      deferrable("rare_a", 100),
      deferrable("rare_b", 100),
    ];
    const sel = selectTurnToolIds({ tools, requestText: "hello" });

    expect(sel.enabled).toBe(false);
    expect(sel.deferredToolIds).toEqual([]);
    expect(sel.savedTokens).toBe(0);
    expect(sel.activeToolIds).toHaveLength(tools.length);
  });

  it("gates on the saving, not on how many tools there are", () => {
    // One expensive tool clears the bar where fifty cheap ones would not.
    const one = selectTurnToolIds({
      tools: [deferrable("huge", MIN_DEFERRAL_SAVING_TOKENS + 1)],
      requestText: "hello",
    });
    expect(one.enabled).toBe(true);

    const many = selectTurnToolIds({
      tools: bulkTools(50, 10),
      requestText: "hello",
    });
    expect(many.enabled).toBe(false);
  });

  it("does not defer inside a sub-agent's granted set", () => {
    // A profile has already narrowed the registry to what it needs, so
    // withholding from that set takes away tools it deliberately granted.
    const granted = bulkTools(30).map((t) => t.id);
    const sel = selectTurnToolIds({
      tools: bulkTools(30),
      requestText: "hello",
      coreToolIds: granted,
    });

    expect(sel.enabled).toBe(false);
    expect(sel.deferredToolIds).toEqual([]);
  });

  it("reports the saving as the sum of what it withheld", () => {
    const tools = [
      ...MEASURED_CORE_TOOL_IDS.slice(0, 3).map((id) => deferrable(id, 200)),
      ...bulkTools(20, 700),
    ];
    const sel = selectTurnToolIds({ tools, requestText: "hello" });

    const byId = new Map(tools.map((t) => [t.id, t.tokens]));
    const expected = sel.deferredToolIds.reduce(
      (sum, id) => sum + (byId.get(id) ?? 0),
      0,
    );
    expect(sel.savedTokens).toBe(expected);
  });

  it("partitions: every tool is either active or deferred, never both", () => {
    const tools = [
      ...MEASURED_CORE_TOOL_IDS.map((id) => deferrable(id, 200)),
      ...bulkTools(40),
    ];
    const sel = selectTurnToolIds({ tools, requestText: "build me an app" });

    expect(sel.activeToolIds.length + sel.deferredToolIds.length).toBe(
      tools.length,
    );
    const overlap = sel.activeToolIds.filter((id) =>
      sel.deferredToolIds.includes(id),
    );
    expect(overlap).toEqual([]);
  });

  it("ranks the core set by measured use, with bash first", () => {
    // Derived from this workspace's own call log, not from taste: `bash` alone
    // is 56.6% of all recorded calls. A hand-edited list would drift from that.
    expect(MEASURED_CORE_TOOL_IDS[0]).toBe("bash");
    expect(new Set(MEASURED_CORE_TOOL_IDS).size).toBe(
      MEASURED_CORE_TOOL_IDS.length,
    );
  });
});

describe("width nudge", () => {
  const base = { nudgesUsed: 0, maxSteps: 100 };

  it("fires after a one-wide step", () => {
    const nudge = resolveParallelWidthNudge({
      ...base,
      stepNumber: 2,
      lastStepToolCalls: 1,
    });
    expect(nudge).not.toBeNull();
    expect(nudge!.target).toBeGreaterThan(1);
  });

  it("stays silent when the model was writing text", () => {
    // Zero tool calls is not a missed batch — there was nothing to batch.
    expect(
      resolveParallelWidthNudge({
        ...base,
        stepNumber: 2,
        lastStepToolCalls: 0,
      }),
    ).toBeNull();
  });

  it("stays silent when the model already batched", () => {
    for (const calls of [2, 3, 9]) {
      expect(
        resolveParallelWidthNudge({
          ...base,
          stepNumber: 2,
          lastStepToolCalls: calls,
        }),
      ).toBeNull();
    }
  });

  it("is bounded so a long turn cannot accumulate a column of reminders", () => {
    expect(
      resolveParallelWidthNudge({
        ...base,
        stepNumber: 5,
        lastStepToolCalls: 1,
        nudgesUsed: MAX_WIDTH_NUDGES_PER_TURN,
      }),
    ).toBeNull();
    expect(
      resolveParallelWidthNudge({
        ...base,
        stepNumber: 5,
        lastStepToolCalls: 1,
        nudgesUsed: MAX_WIDTH_NUDGES_PER_TURN - 1,
      }),
    ).not.toBeNull();
  });

  it("asks for less width as the turn converges", () => {
    const early = resolveParallelWidthNudge({
      ...base,
      stepNumber: WIDTH_TARGET_DESCENT_STEP - 1,
      lastStepToolCalls: 1,
    });
    const late = resolveParallelWidthNudge({
      ...base,
      stepNumber: WIDTH_TARGET_DESCENT_STEP,
      lastStepToolCalls: 1,
    });

    // Early steps are exploratory and genuinely parallel; later ones are
    // usually converging on a single edit, where asking for width produces
    // padding rather than parallelism.
    expect(late!.target).toBeLessThan(early!.target);
  });

  it("stands down near the step ceiling, where wrap-up owns the prompt", () => {
    const maxSteps = 40;
    expect(
      resolveParallelWidthNudge({
        nudgesUsed: 0,
        maxSteps,
        stepNumber: maxSteps - WIDTH_NUDGE_STEP_HEADROOM,
        lastStepToolCalls: 1,
      }),
    ).toBeNull();
    expect(
      resolveParallelWidthNudge({
        nudgesUsed: 0,
        maxSteps,
        stepNumber: maxSteps - WIDTH_NUDGE_STEP_HEADROOM - 1,
        lastStepToolCalls: 1,
      }),
    ).not.toBeNull();
  });

  it("says it is a floor and names no maximum", () => {
    const nudge = resolveParallelWidthNudge({
      ...base,
      stepNumber: 1,
      lastStepToolCalls: 1,
    })!;

    // A fixed tool-call budget widens the gap between a model's perceived and
    // actual need and makes models overrun their own limits. The wording has to
    // ask for a minimum without implying a cap.
    expect(nudge.text).toMatch(/floor, not a limit/i);
    expect(nudge.text).not.toMatch(/at most|no more than|maximum of/i);
  });

  it("gives the model a decidable test, not just an instruction", () => {
    const nudge = resolveParallelWidthNudge({
      ...base,
      stepNumber: 1,
      lastStepToolCalls: 1,
    })!;
    expect(nudge.text).toMatch(/without seeing any of their results/i);
    // And the reason, which models follow more reliably than a bare rule.
    expect(nudge.text).toMatch(/re-sends the entire conversation/i);
  });

  it("keeps sequential work sequential", () => {
    const nudge = resolveParallelWidthNudge({
      ...base,
      stepNumber: 1,
      lastStepToolCalls: 1,
    })!;
    expect(nudge.text).toMatch(/genuinely sequential/i);
  });
});

describe("deferred tool access", () => {
  const registry: Record<string, unknown> = {
    register_schema: {
      id: "register_schema",
      description: "Register a memory graph schema",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ context }: { context: { name: string } }) => ({
        success: true,
        registered: context.name,
      }),
    },
    delete_schema: {
      id: "delete_schema",
      description: "Archive a schema",
      inputSchema: z.object({ schemaId: z.string() }),
      execute: async () => ({ success: true }),
    },
  };

  const deps = (deferred: string[]) => ({
    listDeferredToolIds: () => deferred,
    getTool: (id: string) => registry[id],
  });

  // Flat, not `{ context: args }`. The Mastra version in use validates input
  // against the tool's own schema and hands the parsed object straight to
  // execute, so a wrapped call fails validation before the tool body runs. The
  // tools accept both shapes because older Mastra wrapped it, and the repo's
  // tools are written against that older convention.
  const run = async (tool: any, args: unknown) => await tool.execute(args);

  it("returns full schemas so the model can write the call", () => {
    const find = createFindToolsTool(deps(["register_schema", "delete_schema"]));
    return run(find, { query: "register a schema" }).then((res: any) => {
      expect(res.success).toBe(true);
      const match = res.matches.find((m: any) => m.name === "register_schema");
      expect(match).toBeDefined();
      // A name and description alone would force a guess at the arguments.
      expect(JSON.stringify(match.input_schema)).toContain('"name"');
    });
  });

  it("bounds its own results", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `tool_${i}`);
    const wide: Record<string, unknown> = {};
    for (const id of many) {
      wide[id] = { id, description: "schema thing", inputSchema: z.object({}) };
    }
    const find = createFindToolsTool({
      listDeferredToolIds: () => many,
      getTool: (id) => wide[id],
    });

    const res: any = await run(find, { query: "schema" });
    // An unbounded match on a vague query would return more than the deferral
    // saved — and land it in message context, re-sent every later step.
    expect(res.matches.length).toBeLessThanOrEqual(MAX_FIND_TOOLS_RESULTS);
  });

  it("says so plainly when nothing is deferred", async () => {
    const find = createFindToolsTool(deps([]));
    const res: any = await run(find, { query: "anything" });
    expect(res.matches).toEqual([]);
    expect(res.message).toMatch(/already visible/i);
  });

  it("lists the deferred names when nothing matched", async () => {
    const find = createFindToolsTool(deps(["register_schema"]));
    const res: any = await run(find, { query: "zzzz_nonexistent" });
    expect(res.matches).toEqual([]);
    // Otherwise a failed search is a dead end and the tool is unreachable.
    expect(res.deferred_tool_names).toContain("register_schema");
  });

  it("executes a deferred tool by name", async () => {
    const dispatch = createRunDeferredTool(deps(["register_schema"]));
    const res: any = await run(dispatch, {
      tool_name: "register_schema",
      arguments: { name: "books" },
    });
    expect(res.success).toBe(true);
    expect(res.registered).toBe("books");
  });

  it("returns the schema with the error when arguments do not match", async () => {
    const dispatch = createRunDeferredTool(deps(["register_schema"]));
    const res: any = await run(dispatch, {
      tool_name: "register_schema",
      arguments: { wrong: 1 },
    });

    expect(res.success).toBe(false);
    // The model never saw this schema in the request, so a shape mistake is
    // likely and the schema is what lets it self-correct in one step.
    expect(res.expected_schema).toBeDefined();
    expect(res.issues.length).toBeGreaterThan(0);
  });

  it("names what is available when the tool does not exist", async () => {
    const dispatch = createRunDeferredTool(deps(["register_schema"]));
    const res: any = await run(dispatch, {
      tool_name: "not_a_tool",
      arguments: {},
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("register_schema");
  });
});

describe("dispatcher reaches both routes intact", () => {
  const find: any = createFindToolsTool({
    listDeferredToolIds: () => [],
    getTool: () => undefined,
  });
  const dispatch: any = createRunDeferredTool({
    listDeferredToolIds: () => [],
    getTool: () => undefined,
  });

  it("converts to a usable schema on the OAuth route", () => {
    // pi-ai converts schemas through its own cache, not the AI SDK's, and it
    // warns-and-continues on an empty conversion rather than failing. A
    // dispatcher whose parameters vanish there is worse than no deferral: the
    // model can see the tool, cannot pass arguments, and the deferred tools are
    // unreachable. OAuth is the primary route, so this is checked, not assumed.
    for (const [id, tool] of [
      ["find_tools", find],
      ["run_deferred_tool", dispatch],
    ] as const) {
      const params = getPiToolParameters(id, tool.inputSchema) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      expect(params.required ?? []).not.toEqual([]);
    }

    const runParams = getPiToolParameters(
      "run_deferred_tool",
      dispatch.inputSchema,
    ) as { properties: Record<string, { type?: string }> };
    expect(runParams.properties.tool_name?.type).toBe("string");
    // An open bag: the deferred tool's own shape is unknown at this level, and
    // narrowing it here would reject valid calls.
    expect(runParams.properties.arguments?.type).toBe("object");
  });

  it("uses root object schemas, as OpenAI function calling requires", () => {
    // Same rule `tool-schemas-openai-compat` enforces for the registry. These
    // two are built at request time, so that suite cannot see them.
    expect(find.inputSchema instanceof z.ZodObject).toBe(true);
    expect(dispatch.inputSchema instanceof z.ZodObject).toBe(true);
  });
});

describe("wiring invariants", () => {
  const agentService = stripComments(
    readSource("src/gateway/services/AgentService.ts"),
  );
  const piLoop = stripComments(
    readSource("src/gateway/services/providers/PiCodexStreamWithToolLoop.ts"),
  );

  it("sizes the tool block from the wire payload, not the Zod object", () => {
    expect(agentService).toContain("estimateToolBlockTokens(tools)");
    // The reverted form. It over-states the block 2.31x and the result is
    // subtracted from the history budget, so the error withholds history.
    expect(agentService).not.toContain("JSON.stringify(tools)");
  });

  it("selects the tool set once, before the first step", () => {
    const calls = agentService.split("selectTurnToolIds({").length - 1;
    const selection = agentService.indexOf("selectTurnToolIds({");
    const prepareStep = agentService.indexOf("prepareStep: async");

    expect(selection).toBeGreaterThan(-1);
    expect(prepareStep).toBeGreaterThan(-1);
    // Before the first step, and exactly once. A second call — per step, or
    // re-deciding after a tool result — would revise the tool block mid-turn
    // and re-write the cached prefix. Measured on a 34-step turn with a ~270K
    // prefix that costs $1.55 against the $0.70 the whole turn's deferral
    // saves, so one revision erases more than the feature earns.
    expect(calls).toBe(1);
    expect(selection).toBeLessThan(prepareStep);
  });

  it("nudges on both routes", () => {
    expect(agentService).toContain("resolveParallelWidthNudge({");
    expect(piLoop).toContain("resolveParallelWidthNudge({");
  });

  it("appends the nudge after trimming, so it cannot be trimmed away", () => {
    const start = agentService.indexOf("prepareStep: async");
    const body = agentService.slice(start, start + 6_000);

    // Scoped to the main path. prepareStep has a second trim in the
    // step-limit-warning branch that returns early above the nudge, so a plain
    // indexOf matches *that* one and the ordering holds whatever the main path
    // does — the assertion passes against code that has the bug.
    const mainPath = body.indexOf("const msgs = [...stepOptions.messages];");
    expect(mainPath).toBeGreaterThan(-1);

    const trim = body.indexOf("trimOldestHistoryTurns(msgs", mainPath);
    const nudge = body.indexOf("resolveParallelWidthNudge({", mainPath);
    const cache = body.indexOf("useAnthropicPromptCache", mainPath);

    expect(trim).toBeGreaterThan(-1);
    expect(nudge).toBeGreaterThan(trim);
    // And before cache control, so the breakpoint lands on the real last
    // message rather than on a message the nudge then displaces.
    expect(nudge).toBeLessThan(cache);
  });

  it("records the interventions so their effect is attributable", () => {
    expect(agentService).toContain("recordToolDeferral(turnMetrics");
    expect(agentService).toContain("recordWidthNudge(turnMetrics)");
    expect(piLoop).toContain("recordWidthNudge(toolContext?.turnMetrics)");
  });
});
