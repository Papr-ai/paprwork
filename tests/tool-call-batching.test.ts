/**
 * Steps are the billed unit — every one re-sends the whole context — so how
 * *wide* each step is decides what a turn costs. Measured on 18 real turns we
 * average 1.19 tool calls per step, and the worst turn (93 steps, 94 calls) ran
 * at 1.01: effectively serial. The research optimum is 3-4 primitive actions
 * per round, so this is the largest lever entirely on our side of the wire.
 *
 * These tests cover the guidance that asks for batching, the metric that will
 * tell us whether it worked, and the duplicate registration found while
 * measuring the tool block.
 *
 * See docs/AGENT_STEP_BUDGET_RESEARCH.md Part 4, Tier 2.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { allTools } from "../src/core/tools/index.js";
import {
  createTurnMetrics,
  recordStep,
  setToolCallCount,
  summarizeTurnMetrics,
} from "../src/gateway/services/agent/turnMetrics.js";
import { buildSystemPrompt } from "../src/core/agents/SystemPrompt.js";

describe("batching guidance", () => {
  /**
   * The section builder is private, so assert against the assembled prompt.
   * That is also the stronger claim: it proves the text actually reaches the
   * model, not merely that a builder exists.
   */
  const prompt = buildSystemPrompt();

  it("asks the model to batch independent calls, with a width target", () => {
    expect(prompt).toContain("Batch independent calls into one step");
    // A bare "call them in parallel if independent" bullet was already present
    // and produced 1.19. The target is what makes it actionable.
    expect(prompt).toMatch(/[Tt]hree or\s+more per step/);
  });

  it("explains why, not just what", () => {
    // Models follow a reason more reliably than a rule, and the reason here is
    // the whole finding: the context is re-sent per step, not per tool call.
    expect(prompt).toMatch(/re-sends the whole context/i);
  });

  it("names the sequential cases so batching is not over-applied", () => {
    // The literature's counter-evidence: over-chunking lowered success rates on
    // smaller models, and batching genuinely sequential work costs ~8% more.
    // Without these, the guidance trades cost against correctness.
    expect(prompt).toContain("Do not batch these");
    expect(prompt).toMatch(/write_file.*read_file/s);
    expect(prompt).toMatch(/create_job.*run_job/s);
  });

  it("gives a test the model can apply without judgement", () => {
    // "Could you write both argument lists right now?" is decidable; "are these
    // independent?" is not.
    expect(prompt).toMatch(/without seeing either result/i);
  });

  it("does not impose a fixed tool-call budget", () => {
    // Deliberate: a fixed budget was measured to *widen* the gap between
    // perceived and true need and to make models overrun their own limits. This
    // guidance sets a floor on step width, never a ceiling on work — so the
    // prompt must say so, and must not name a maximum.
    expect(prompt).toMatch(/not a limit on how much you may\s+do/);
    expect(prompt).toMatch(/never less work/);
    expect(prompt).not.toMatch(/at most \d+ tool calls/i);
    expect(prompt).not.toMatch(/no more than \d+ (tool calls|steps)/i);
  });

  it("costs little, since the prompt prefix is cached at ~97%", () => {
    // Guard against the section growing into a chapter. ~4 chars/token on
    // prose, so 4,000 chars is roughly 1,000 tokens.
    const start = prompt.indexOf("Batch independent calls into one step");
    const end = prompt.indexOf("## Tool Call Ordering", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThan(4_000);
  });
});

describe("toolCallsPerStep", () => {
  function summarize(steps: number, toolCalls: number) {
    const m = createTurnMetrics();
    for (let i = 0; i < steps; i++) recordStep(m, {});
    setToolCallCount(m, toolCalls);
    return summarizeTurnMetrics(m).toolCallsPerStep;
  }

  it("reports the ratio the guidance targets", () => {
    // The real turns this fix was measured against.
    expect(summarize(93, 94)).toBeCloseTo(1.011, 3);
    expect(summarize(19, 33)).toBeCloseTo(1.737, 3);
    // And what success looks like.
    expect(summarize(32, 94)).toBeCloseTo(2.938, 3);
  });

  it("is null with no steps rather than a confident zero", () => {
    // An unmeasured turn and a turn that made no calls are different facts, and
    // 0 would average into the aggregate as if it were the second.
    expect(summarize(0, 0)).toBeNull();
  });

  it("counts a step that called nothing", () => {
    // A text-only step still re-sends the context, so it belongs in the
    // denominator — that is the cost this ratio exists to expose.
    expect(summarize(4, 2)).toBe(0.5);
  });
});

describe("tool registry", () => {
  it("registers no tool twice", () => {
    // `ToolRegistry.register` is a `Map.set`, so a duplicate id silently
    // shadows rather than failing. Found by counting: 152 entries, 150 ids —
    // appJobsTools re-listed two tools that cloudPublishTools already owned.
    const counts = new Map<string, number>();
    for (const tool of allTools) {
      counts.set(tool.id, (counts.get(tool.id) ?? 0) + 1);
    }
    const duplicates = [...counts].filter(([, n]) => n > 1);
    expect(duplicates, `duplicate tool ids: ${JSON.stringify(duplicates)}`).toEqual([]);
  });

  it("costs far less on the wire than AgentService estimates", () => {
    // AgentService reads the block as `JSON.stringify(tools).length / 4`, which
    // measures the wrong object: a Zod schema's shape lives in `_def`, and
    // stringifying walks that whole tree. It reports 87,363 tokens against a
    // real wire cost of ~37,800 — 2.3x over, and 15x over on the two schema
    // tools whose `_def` trees are deepest.
    //
    // This is pinned because the overstatement misled a research doc into
    // calling the tool block 43% of a 200K window (it is ~19%) and into
    // nominating register_schema/update_schema as ~30% of it (they are 4.3%).
    // It also feeds computeHistoryTokenBudget, where it is currently acting as
    // an unintended history cap — correcting that changes trimming behaviour
    // and so belongs in its own change, not bundled with this one.
    let wireChars = 0;
    const seen = new Set<string>();
    for (const tool of allTools) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      const schema = (tool as unknown as { inputSchema?: unknown }).inputSchema;
      let jsonSchema: unknown = {};
      if (schema instanceof z.ZodType) {
        jsonSchema = z.toJSONSchema(schema, {
          io: "input",
          unrepresentable: "any",
        });
      }
      wireChars += JSON.stringify({
        name: tool.id,
        description: tool.description ?? "",
        input_schema: jsonSchema,
      }).length;
    }

    const stringifyChars = JSON.stringify(
      Object.fromEntries(allTools.map((t) => [t.id, t])),
    ).length;

    // ~4.2 chars/token measured on this text with cl100k_base.
    expect(wireChars).toBeLessThan(stringifyChars / 2);
    // And the honest figure is comfortably under a fifth of a 200K window,
    // which is the number any deferral decision should be argued from.
    expect(wireChars / 4.2 / 200_000).toBeLessThan(0.25);
  });
});
