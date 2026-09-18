/**
 * Tool-block measurement, and the history cap that keeps correcting it safe.
 *
 * Two linked claims are pinned here:
 *
 *  1. The old estimate measured the wrong object. `JSON.stringify(tools)` walks
 *     Zod's internal `_def` tree, which the provider never receives, so it
 *     over-states the block. The fix builds the wire payload instead.
 *
 *  2. That estimate is *subtracted* from the history budget, so correcting it
 *     downward widens history. The cap bounds how far, because a wider history
 *     costs more per request and changes trimming — a separate decision from
 *     measuring honestly, and it should not ride in silently on this one.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  DEFAULT_HISTORY_TOKEN_CAP,
  GEMINI_HISTORY_TOKEN_CAP,
  computeHistoryTokenBudget,
  resolveHistoryTokenBudget,
} from "../src/gateway/services/agent/contextBudget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  __resetToolBlockTokenCache,
  estimateToolBlockTokens,
  estimateToolTokens,
  toolBlockChars,
  toolWirePayload,
} from "../src/gateway/services/agent/toolSchemaTokens.js";

/** A schema deep enough that Zod's `_def` tree dwarfs its JSON Schema. */
const deepSchema = z.object({
  name: z.string().describe("A name"),
  nested: z.object({
    flag: z.boolean().optional(),
    choice: z.enum(["a", "b", "c"]),
    items: z.array(
      z.object({
        id: z.string(),
        weight: z.number().min(0).max(1),
      }),
    ),
  }),
});

function tool(id: string, schema: z.ZodType, description = "does a thing") {
  return { id, description, inputSchema: schema };
}

beforeEach(() => {
  __resetToolBlockTokenCache();
});

describe("tool wire payload", () => {
  it("emits JSON Schema, not Zod internals", () => {
    const wire = toolWirePayload("deep", tool("deep", deepSchema));
    const text = JSON.stringify(wire.input_schema);

    expect(text).toContain('"type":"object"');
    expect(text).toContain('"properties"');
    // The two markers that prove we serialized the Zod object by mistake.
    expect(text).not.toContain("_def");
    expect(text).not.toContain("typeName");
  });

  it("is materially smaller than stringifying the Zod object", () => {
    const t = tool("deep", deepSchema);
    const wireChars = JSON.stringify(toolWirePayload("deep", t)).length;
    const zodChars = JSON.stringify(t).length;

    // Measured across the real registry the ratio is 2.31x. Asserting only the
    // direction and a conservative floor keeps this from breaking on a Zod
    // version bump while still failing if someone reverts to stringify.
    expect(zodChars).toBeGreaterThan(wireChars * 1.5);
  });

  it("carries the tool's own id and description", () => {
    const wire = toolWirePayload("fallback_key", {
      id: "real_id",
      description: "the description",
      inputSchema: z.object({}),
    });
    expect(wire.name).toBe("real_id");
    expect(wire.description).toBe("the description");
  });

  it("falls back to the record key when the tool has no id", () => {
    const wire = toolWirePayload("from_key", { inputSchema: z.object({}) });
    expect(wire.name).toBe("from_key");
    expect(wire.description).toBe("");
  });

  it("does not throw on a schema that cannot be converted", () => {
    const hostile = {
      _def: {},
      // Present so the Zod branch is taken, then throws.
      get shape(): never {
        throw new Error("nope");
      },
    };
    expect(() =>
      toolWirePayload("hostile", { inputSchema: hostile }),
    ).not.toThrow();
  });

  it("passes plain JSON Schema through untouched", () => {
    const plain = { type: "object", properties: { a: { type: "string" } } };
    const wire = toolWirePayload("plain", { inputSchema: plain });
    expect(wire.input_schema).toEqual(plain);
  });
});

describe("block estimate", () => {
  it("sums the whole block", () => {
    const tools = {
      a: tool("a", z.object({ x: z.string() })),
      b: tool("b", deepSchema),
    };
    const chars = toolBlockChars(tools);
    expect(estimateToolBlockTokens(tools)).toBe(Math.ceil(chars / 4));
  });

  it("does not share a memo entry between different tool sets", () => {
    const wide = { a: tool("a", deepSchema), b: tool("b", deepSchema) };
    const narrow = { a: tool("a", deepSchema) };

    const wideTokens = estimateToolBlockTokens(wide);
    const narrowTokens = estimateToolBlockTokens(narrow);

    // The whole point of deferral is that a narrower set is cheaper.
    expect(narrowTokens).toBeLessThan(wideTokens);
    expect(estimateToolBlockTokens(wide)).toBe(wideTokens);
  });

  it("distinguishes two sets of the same size but different content", () => {
    // Deferral swaps tools in and out, so two selections of equal length with
    // very different schemas are routine. A memo keyed on the tool *count*
    // would hand the second one the first's figure — which passes a
    // narrow-vs-wide test and is wrong exactly where it matters.
    const heavy = { a: tool("a", deepSchema), b: tool("b", deepSchema) };
    const light = {
      c: tool("c", z.object({ x: z.string() })),
      d: tool("d", z.object({ y: z.string() })),
    };

    expect(Object.keys(heavy).length).toBe(Object.keys(light).length);
    expect(estimateToolBlockTokens(light)).toBeLessThan(
      estimateToolBlockTokens(heavy),
    );
  });

  it("is insensitive to key order", () => {
    const one = { a: tool("a", deepSchema), b: tool("b", deepSchema) };
    const two = { b: tool("b", deepSchema), a: tool("a", deepSchema) };
    expect(estimateToolBlockTokens(two)).toBe(estimateToolBlockTokens(one));
  });

  it("agrees with the per-tool estimate", () => {
    const t = tool("solo", deepSchema);
    expect(estimateToolBlockTokens({ solo: t })).toBe(
      estimateToolTokens("solo", t),
    );
  });
});

describe("history budget", () => {
  /** The pure arithmetic: window share, minus tools, minus output reserve. */
  const raw = (toolTokens: number, contextLimit?: number) =>
    computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: toolTokens,
      maxOutputTokens: 128_000,
      contextLimit,
    });

  /** What a live turn gets: the arithmetic, held to the validated ceiling. */
  const live = (toolTokens: number, contextLimit?: number) =>
    resolveHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      toolTokenEstimate: toolTokens,
      maxOutputTokens: 128_000,
      contextLimit,
    });

  // The measured figures: 88,477 was the over-estimate, 38,526 the real wire
  // cost of all 152 schemas, 11,051 the core-40 set that deferral sends.
  const OVER_ESTIMATE = 88_477;
  const REAL_BLOCK = 38_526;
  const DEFERRED_BLOCK = 11_051;

  it("recovers the 200K tier that the over-estimate had starved", () => {
    const before = live(OVER_ESTIMATE, 200_000);
    const after = live(REAL_BLOCK, 200_000);

    expect(before).toBe(14_857);
    expect(after).toBe(64_808);
    // This is the tier the measurement error hurt most: a user who picked the
    // smallest cap to save money was getting a quarter of the history the
    // arithmetic intends. The ceiling does not bind here, so the whole
    // correction reaches the user.
    expect(after).toBeGreaterThan(before * 4);
  });

  it("widens the 400K tier only as far as the ceiling allows", () => {
    // 123,523 is the figure every real turn on this workspace recorded, which
    // is what identified the bug. The honest arithmetic gives 173,474 — so the
    // ceiling, not the measurement, is what holds a live turn back.
    expect(raw(OVER_ESTIMATE, 400_000)).toBe(123_523);
    expect(raw(REAL_BLOCK, 400_000)).toBe(173_474);
    expect(live(REAL_BLOCK, 400_000)).toBe(DEFAULT_HISTORY_TOKEN_CAP);
  });

  it("holds the widest windows rather than handing over the whole thing", () => {
    // No user cap on a 1M model: the arithmetic offers 683,474 and a live turn
    // gets the validated ceiling instead. (context-cap-enforcement pins the
    // same case at 634,637 — that figure is the same arithmetic with the old
    // 87,363 tool estimate, so the 48,837 difference is exactly the
    // measurement correction showing through.)
    expect(raw(REAL_BLOCK, undefined)).toBe(683_474);
    expect(live(REAL_BLOCK, undefined)).toBe(DEFAULT_HISTORY_TOKEN_CAP);
  });

  it("does not let deferral widen history past the ceiling either", () => {
    // Deferral shrinks the subtrahend further still, so it pushes in the same
    // direction. The ceiling has to bound both or the two fixes compound.
    expect(live(DEFERRED_BLOCK, 400_000)).toBe(DEFAULT_HISTORY_TOKEN_CAP);
    // Under a 200K cap there is genuinely less room, so deferral shows through.
    expect(live(DEFERRED_BLOCK, 200_000)).toBe(92_283);
  });

  it("leaves the arithmetic pure so upstream guards stay observable", () => {
    // The ceiling is applied by the resolver, never inside the arithmetic. A
    // cap at the end of computeHistoryTokenBudget would be the last word: at
    // 400K+ it flattens the output-reserve fix (Issue 89) and the Gemini
    // ceiling to the same number, so neither remains observable through the
    // public function and both of their tests degrade into assertions about
    // this constant.
    expect(raw(REAL_BLOCK, 400_000)).toBeGreaterThan(DEFAULT_HISTORY_TOKEN_CAP);
    expect(raw(REAL_BLOCK, 1_000_000)).toBeGreaterThan(
      raw(REAL_BLOCK, 400_000),
    );

    // Gemini's own ceiling still shows through the arithmetic, and is still
    // the looser of the two — which is exactly why it must not be folded in.
    const gemini = computeHistoryTokenBudget({
      provider: "google",
      modelId: "gemini-2.5-pro",
      toolTokenEstimate: REAL_BLOCK,
      maxOutputTokens: 65_536,
    });
    expect(gemini).toBe(GEMINI_HISTORY_TOKEN_CAP);
    expect(GEMINI_HISTORY_TOKEN_CAP).toBeGreaterThan(DEFAULT_HISTORY_TOKEN_CAP);
  });

  it("holds every provider to the ceiling, Gemini included", () => {
    // The resolver is provider-blind, so Gemini cannot end up looser than the
    // providers its own cap was written to protect against.
    const gemini = resolveHistoryTokenBudget({
      provider: "google",
      modelId: "gemini-2.5-pro",
      toolTokenEstimate: REAL_BLOCK,
      maxOutputTokens: 65_536,
    });
    expect(gemini).toBe(DEFAULT_HISTORY_TOKEN_CAP);
  });

  it("un-clamps the smallest allowed window, which the over-estimate had floored", () => {
    // At the 128K minimum the over-estimate drove the arithmetic negative, so
    // the budget clamped to its 8K floor and stopped bounding anything at all.
    // The honest figure leaves a real, if small, budget.
    expect(live(OVER_ESTIMATE, 128_000)).toBe(8_000);
    expect(live(REAL_BLOCK, 128_000)).toBe(27_608);
  });

  it("still clamps to the 8K floor when there genuinely is no room", () => {
    const noRoom = computeHistoryTokenBudget({
      provider: "anthropic",
      modelId: "claude-opus-5",
      // A tool block larger than the whole window: the floor is the only thing
      // standing between this and a negative budget.
      toolTokenEstimate: 400_000,
      maxOutputTokens: 128_000,
      contextLimit: 200_000,
    });
    expect(noRoom).toBe(8_000);
  });

  it("is applied by the live turn, not left to the caller to remember", () => {
    // The whole design rests on production calling the resolver. If the call
    // site drifts back to the raw arithmetic the ceiling silently stops
    // existing, and nothing else in this file would notice.
    const agentService = readFileSync(
      resolve(__dirname, "../src/gateway/services/AgentService.ts"),
      "utf8",
    );
    expect(agentService).toContain("resolveHistoryTokenBudget({");
    expect(agentService).not.toContain("computeHistoryTokenBudget({");
  });

  it("caps below the largest budget this workspace has actually run", () => {
    // 123,523 ran and worked; the cap sits just above it. Raising this is a
    // cost/quality decision to be made on recorded turn metrics, not by feel,
    // so the relationship is pinned rather than left implicit.
    expect(DEFAULT_HISTORY_TOKEN_CAP).toBeGreaterThan(123_523);
    expect(DEFAULT_HISTORY_TOKEN_CAP).toBeLessThan(173_474);
  });
});
