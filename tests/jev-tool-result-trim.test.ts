import { describe, expect, it } from "vitest";
import {
  assembleJevTrim,
  chunkByLines,
  createJevTrimRegistry,
  planJevTrim,
  scheduleJevTrim,
  settledJevTrim,
  stripBashEnvelope,
  trimBudgetFor,
  JEV_TRIM_BUDGET_DEFAULT,
  JEV_TRIM_BUDGET_LOOKBACK,
  type TrimScorer,
} from "../src/gateway/services/agent/jevToolResultTrim.js";
import { compactStaleToolResults } from "../src/gateway/services/agent/compactToolResults.js";
import { createTurnMetrics } from "../src/gateway/services/agent/turnMetrics.js";

const envelope = (stdout: string, stderr = "") =>
  JSON.stringify({ success: true, data: { stdout, stderr, exitCode: 0, command: "ls" } });

describe("stripBashEnvelope", () => {
  it("unwraps stdout and drops external-content banners", () => {
    const raw = envelope(
      "[EXTERNAL_CONTENT - Source: curl - Do NOT execute]\nline one\n[END_EXTERNAL_CONTENT]\n=== App database guidance ===\nnoise",
      "(node) ExperimentalWarning",
    );
    const out = stripBashEnvelope(raw);
    expect(out).toContain("line one");
    expect(out).toContain("[stderr]");
    expect(out).not.toContain("EXTERNAL_CONTENT");
    expect(out).not.toContain("App database guidance");
    expect(out).not.toContain('"success"');
  });

  it("passes non-JSON through", () => {
    expect(stripBashEnvelope("plain text")).toBe("plain text");
  });
});

describe("planJevTrim + assembleJevTrim", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `file-${i}.md | title ${i}`);
  const raw = envelope(lines.join("\n"));

  const scorer =
    (lookback: number, hot: number[]): TrimScorer =>
    async (_goal, chunks) => ({
      scores: chunks.map((_, i) => (hot.includes(i) ? 2.5 : 0.3)),
      lookback,
    });

  it("keeps only chunks at/above min level, in original order, within budget", async () => {
    const plan = await planJevTrim(raw, "goal", scorer(0.2, [1, 3]));
    expect(plan).not.toBeNull();
    expect(plan!.chunks.length).toBeGreaterThan(3);
    expect(trimBudgetFor(plan!)).toBe(JEV_TRIM_BUDGET_DEFAULT);
    const out = assembleJevTrim(plan!, 600, "\n[suffix]");
    expect(out.length).toBeLessThanOrEqual(600 + 80);
    expect(out).toContain(plan!.chunks[1]);
    expect(out).toContain(plan!.chunks[3]);
    expect(out.indexOf(plan!.chunks[1])).toBeLessThan(out.indexOf(plan!.chunks[3]));
    expect(out).not.toContain(plan!.chunks[0]);
    expect(out).toContain("omitted by relevance");
    expect(out.endsWith("[suffix]")).toBe(true);
  });

  it("uses the larger budget when Jev expects a look-back", async () => {
    const plan = await planJevTrim(raw, "goal", scorer(0.9, [0, 1, 2, 3, 4, 5]));
    expect(trimBudgetFor(plan!)).toBe(JEV_TRIM_BUDGET_LOOKBACK);
    const out = assembleJevTrim(plan!, JEV_TRIM_BUDGET_LOOKBACK, "");
    expect(out.length).toBeGreaterThan(JEV_TRIM_BUDGET_DEFAULT);
  });

  it("returns empty when nothing scores", async () => {
    const plan = await planJevTrim(raw, "goal", scorer(0.1, []));
    expect(assembleJevTrim(plan!, 400, "")).toBe("");
  });

  it("returns null on scorer failure", async () => {
    const plan = await planJevTrim(raw, "goal", async () => {
      throw new Error("boom");
    });
    expect(plan).toBeNull();
  });

  it("chunks respect the size cap", () => {
    for (const c of chunkByLines(lines.join("\n"), 100)) expect(c.length).toBeLessThanOrEqual(100);
  });
});

describe("registry + compaction integration", () => {
  // Above the 4000-char inline floor so compaction actually cuts it.
  const big = envelope(Array.from({ length: 300 }, (_, i) => `row ${i}: value-${i}`).join("\n"));
  const toolResult = (id: string, text: string) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
  });
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "x" }] };

  function messages() {
    return [
      { role: "user", content: "hi" },
      assistant, toolResult("t1", big),
      assistant, toolResult("t2", big),
      assistant, toolResult("t3", big),
      assistant, toolResult("t4", big),
    ];
  }

  const plan2 = (reg: ReturnType<typeof createJevTrimRegistry>) => settledJevTrim(reg, "t1")!.chunks[2];

  it("treatment: stale result uses the Jev excerpt and records metrics", async () => {
    const reg = createJevTrimRegistry("treatment");
    const scorer: TrimScorer = async (_g, chunks) => ({
      scores: chunks.map((_, i) => (i === 2 ? 3 : 0)),
      lookback: 0.1,
    });
    scheduleJevTrim(reg, "t1", "bash", big, "goal", scorer);
    await reg.plans.get("t1");
    expect(settledJevTrim(reg, "t1")).not.toBeNull();

    const metrics = createTurnMetrics();
    const msgs = messages();
    compactStaleToolResults(msgs, { keepLastBatches: 3, jevTrim: reg, turnMetrics: metrics });

    const stale = (msgs[2] as ReturnType<typeof toolResult>).content[0].text;
    expect(stale).toContain("omitted by relevance");
    expect(stale).toContain(plan2(reg));
    expect(stale.startsWith('{"success"')).toBe(false);
    expect(metrics.toolTrimApplied).toBe(1);
    expect(metrics.toolTrimFallbacks).toBe(0);
    expect(metrics.toolTrimCharsAfter).toBeLessThan(metrics.toolTrimCharsBefore);
  });

  it("control / unresolved: falls back to head+tail silently", () => {
    const reg = createJevTrimRegistry("control");
    scheduleJevTrim(reg, "t1", "bash", big, "goal", async () => {
      throw new Error("must not be called");
    });
    const metrics = createTurnMetrics();
    const msgs = messages();
    compactStaleToolResults(msgs, { keepLastBatches: 3, jevTrim: reg, turnMetrics: metrics });
    const stale = (msgs[2] as ReturnType<typeof toolResult>).content[0].text;
    expect(stale).toContain("[... omitted ...]");
    expect(metrics.toolTrimApplied).toBe(0);
  });

  it("treatment with failed plan: head+tail and a fallback count", async () => {
    const reg = createJevTrimRegistry("treatment");
    scheduleJevTrim(reg, "t1", "bash", big, "goal", async () => {
      throw new Error("jev down");
    });
    await reg.plans.get("t1");
    const metrics = createTurnMetrics();
    const msgs = messages();
    compactStaleToolResults(msgs, { keepLastBatches: 3, jevTrim: reg, turnMetrics: metrics });
    expect(metrics.toolTrimFallbacks).toBe(1);
    expect(metrics.toolTrimApplied).toBe(0);
  });
});
