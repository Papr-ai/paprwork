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
  JEV_TRIM_BUDGET,
  isJevTrimEligible,
  type TrimScorer,
} from "../src/gateway/services/agent/jevToolResultTrim.js";
import { compactStaleToolResults } from "../src/gateway/services/agent/compactToolResults.js";
import {
  createTurnMetrics,
  extractIdentifiers,
  finalizeToolTrimHitRate,
  recordToolTrimRecovery,
} from "../src/gateway/services/agent/turnMetrics.js";

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

  it("keeps the last chunk plus top-scored chunks, in original order, within budget", async () => {
    const plan = await planJevTrim(raw, "goal", scorer(0.2, [1, 3]));
    expect(plan).not.toBeNull();
    expect(trimBudgetFor(plan!)).toBe(JEV_TRIM_BUDGET);
    const small = plan!.chunks.map((c) => c.slice(0, 120));
    const p2 = { ...plan!, chunks: [...small, "exit 1: boom", "b", "c", "d"].slice(0, 6) };
    p2.scores = p2.chunks.map((_, i) => (i === 1 || i === 3 ? 2.5 : 0.3));
    const last = p2.chunks[p2.chunks.length - 1];
    const out = assembleJevTrim(p2, 140, "\n[suffix]");
    expect(out).toContain(p2.chunks[1]);
    expect(out).toContain(p2.chunks[3]);
    expect(out).toContain(last);
    expect(out.indexOf(p2.chunks[1])).toBeLessThan(out.indexOf(p2.chunks[3]));
    expect(out).not.toContain(p2.chunks[0]);
    expect(out).toContain("omitted by relevance");
    expect(out.endsWith("[suffix]")).toBe(true);
  });

  it("only results over the 10K inline floor are eligible", () => {
    expect(isJevTrimEligible("bash", "x".repeat(8_000))).toBe(false);
    expect(isJevTrimEligible("bash", "x".repeat(12_000))).toBe(true);
    expect(isJevTrimEligible("read_file", "x".repeat(12_000))).toBe(false);
  });

  it("returns null on scorer failure", async () => {
    const plan = await planJevTrim(raw, "goal", async () => {
      throw new Error("boom");
    });
    expect(plan).toBeNull();
  });

  it("chunks respect the size cap, splitting long lines", () => {
    for (const c of chunkByLines(lines.join("\n"), 100)) expect(c.length).toBeLessThanOrEqual(100);
    const long = chunkByLines("a".repeat(1_250) + "\nshort", 500);
    expect(long.map((c) => c.length)).toEqual([500, 500, 250 + 1 + 5]);
  });
});

describe("registry + compaction integration", () => {
  // Above the 10K-char inline floor so compaction actually cuts it.
  const big = envelope(Array.from({ length: 800 }, (_, i) => `row ${i}: value-${i}`).join("\n"));
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
    expect(metrics.toolTrimCuts.get("t1")).toBe(stale);
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
    // Control cuts are tracked too, so hit rate compares across arms.
    expect(metrics.toolTrimCuts.get("t1")).toBe(stale);
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
    // Compaction re-runs every step; the same failed result must not recount.
    compactStaleToolResults(messages(), { keepLastBatches: 3, jevTrim: reg, turnMetrics: metrics });
    expect(metrics.toolTrimFallbacks).toBe(1);
  });

  it("compaction schedules scoring for results the tool loop did not (AI SDK path)", () => {
    const reg = createJevTrimRegistry("treatment", "find the failing row");
    compactStaleToolResults(messages(), { keepLastBatches: 3, jevTrim: reg });
    expect(reg.plans.has("t1")).toBe(true);
    const control = createJevTrimRegistry("control", "x");
    compactStaleToolResults(messages(), { keepLastBatches: 3, jevTrim: control });
    expect(control.plans.size).toBe(0);
  });
});

describe("applyMidTurnContextShaping records compaction into turn metrics", () => {
  it("counts a mid-turn stale cut (previously invisible)", async () => {
    const { applyMidTurnContextShaping } = await import(
      "../src/gateway/services/providers/piStreamMemoryWrapUp.js"
    );
    const big = JSON.stringify({ success: true, data: { stdout: "x".repeat(14000), stderr: "", exitCode: 0 } });
    const tr = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: big }] });
    const asst = { role: "assistant", content: [{ type: "toolCall", id: "x" }] };
    const msgs = [{ role: "user", content: "hi" }, asst, tr("a"), asst, tr("b"), asst, tr("c"), asst, tr("d")];
    const metrics = createTurnMetrics();
    applyMidTurnContextShaping(msgs, undefined, false, { turnMetrics: metrics });
    expect(metrics.compactionRuns).toBe(1);
    expect(metrics.staleResultsTruncated).toBeGreaterThan(0);
  });

  it("counts a pressure-gate skip", async () => {
    const { applyMidTurnContextShaping } = await import(
      "../src/gateway/services/providers/piStreamMemoryWrapUp.js"
    );
    const msgs = [{ role: "user", content: "hi" }];
    const metrics = createTurnMetrics();
    applyMidTurnContextShaping(msgs, { maxTokens: 1_000_000 } as never, false, { turnMetrics: metrics });
    expect(metrics.compactionSkips).toBe(1);
  });
});

describe("tool-trim hit-rate logging", () => {
  it("extracts identifiers, not plain words", () => {
    const ids = extractIdentifiers("status remaining developer_user_id devbar.ts onSelectSection MAX_ITEMS 429 the");
    expect([...ids].sort()).toEqual(["MAX_ITEMS", "devbar.ts", "developer_user_id", "onSelectSection"].sort());
  });

  it("scores a recovered cut: needed = full-result ids used next, kept = those in the excerpt", () => {
    const m = createTurnMetrics();
    const full = "def mark_awaiting(): pass\ndef record_action(): pass\nslug_of = 1";
    m.toolTrimCuts.set("t1", "def mark_awaiting(): pass\n[… omitted]");
    recordToolTrimRecovery(m, "t1", full);
    recordToolTrimRecovery(m, "t1", full); // second page — not recounted
    recordToolTrimRecovery(m, "untracked", full);
    expect(m.toolTrimCutRecoveries).toBe(1);
    finalizeToolTrimHitRate(m, [
      { toolCallId: "t1", toolName: "bash", args: { command: "sed -n 1,80p jobs/x.py" } },
      { toolCallId: "r1", toolName: "get_full_tool_result", args: { toolCallId: "t1" } },
      { toolCallId: "e1", toolName: "edit_file", args: { newString: "mark_awaiting(); record_action(); slug_of" } },
    ]);
    expect(m.toolTrimNeededIds).toBe(3);
    expect(m.toolTrimKeptIds).toBe(1);
  });
});
