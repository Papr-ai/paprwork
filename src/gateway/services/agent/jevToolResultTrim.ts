/**
 * Jev-selected excerpts for stale bash results (experiment JEV_TOOL_TRIM).
 *
 * Why: get_full_tool_result is the #2 tool by volume (3.8k calls / 30d, 70%
 * of them paging back a *bash* result). A stale bash result is cut to 400
 * chars head+tail, which keeps the JSON envelope and the command echo — the
 * two least useful parts — and drops the middle, where the facts were.
 *
 * What: when a bash result lands, strip the envelope, split into ~240-char
 * line chunks and ask Jev two things in one call: (a) per chunk, how useful
 * is it for what the agent was doing, (b) will the agent likely need to look
 * back at this result. Cache the answer on the message. When the result goes
 * stale, compaction assembles the best chunks into the budget the gate chose
 * (2000 if "look back", else 400) instead of head+tail.
 *
 * Latency: scoring starts when the tool returns and is awaited only at
 * compaction time, ≥3 model steps later. If it has not resolved by then, the
 * old head+tail path runs. Any Jev failure → old path.
 */

import { GOAL_LEVELS } from "../../../core/tools/pageExtract.js";

export const JEV_TOOL_TRIM_EXPERIMENT = "JEV_TOOL_TRIM";
export const JEV_TRIM_CHUNK_CHARS = 200;
export const JEV_TRIM_MAX_CHUNKS = 48; // ~11k chars scored; beyond that, tail is dropped
export const JEV_TRIM_MIN_LEVEL = 1; // GOAL_LEVELS index: "related"
export const JEV_TRIM_LOOKBACK_THRESHOLD = 0.6;
export const JEV_TRIM_BUDGET_LOOKBACK = 2000;
export const JEV_TRIM_BUDGET_DEFAULT = 400;
export const JEV_TRIM_MIN_INPUT_CHARS = 400;
export const JEV_TRIM_MAX_INPUT_CHARS = 40_000;
export const JEV_TRIM_TIMEOUT_MS = 8_000;
export const JEV_TRIM_TOOLS = new Set(["bash"]);

export interface JevTrimPlan {
  chunks: string[];
  scores: number[];
  /** P(agent will need to look back at this result). */
  lookback: number;
  jevMs: number;
  /** Chars of payload after envelope strip, before selection. */
  strippedChars: number;
}

export type TrimScorer = (
  goal: string,
  chunks: string[],
) => Promise<{ scores: number[]; lookback: number }>;

/** Bash tool JSON envelope → stdout/stderr text. Non-JSON passes through. */
export function stripBashEnvelope(raw: string): string {
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as {
      data?: { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
      error?: unknown;
    };
    const d = parsed?.data;
    if (d && (typeof d.stdout === "string" || typeof d.stderr === "string")) {
      const parts: string[] = [];
      if (typeof d.stdout === "string" && d.stdout.trim()) parts.push(d.stdout);
      if (typeof d.stderr === "string" && d.stderr.trim()) parts.push(`[stderr]\n${d.stderr}`);
      if (typeof d.exitCode === "number" && d.exitCode !== 0) parts.push(`[exit ${d.exitCode}]`);
      if (typeof parsed.error === "string") parts.push(`[error] ${parsed.error}`);
      text = parts.join("\n");
    }
  } catch {
    /* not JSON */
  }
  return text
    .replace(/^\[EXTERNAL_CONTENT - [^\n]*\]\n?/gm, "")
    .replace(/^\[END_EXTERNAL_CONTENT\]\n?/gm, "")
    .replace(/\n=== App database guidance ===[\s\S]*?(?=\n\[stderr\]|$)/m, "")
    .trim();
}

export function chunkByLines(text: string, size = JEV_TRIM_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > size && cur) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out.slice(0, JEV_TRIM_MAX_CHUNKS);
}

export function buildTrimGoal(userMessage: string, command: string): string {
  return (
    `User asked: ${userMessage.slice(0, 600)}\n` +
    `Agent ran this shell command to make progress: ${command.slice(0, 600)}`
  );
}

/** Default scorer: one Jev call — per-chunk score + lookback noul. */
export const jevTrimScorer: TrimScorer = async (goal, chunks) => {
  const { evaluateJevWithAuth } = await import("../../../core/tools/jevAuth.js");
  const items = Object.fromEntries(chunks.map((c, i) => [`c${i}`, c]));
  const questions: Record<string, unknown> = {
    lookback: {
      type: "noul",
      instructions:
        "The agent has already read this command output and moved on. Will it likely need to look back at specific facts in it later in this task (paths, ids, values, error text it must act on)? No if the output was a one-off check, confirmation, or mostly noise.",
    },
  };
  for (const k of Object.keys(items)) {
    questions[k] = {
      type: "score",
      criteria: GOAL_LEVELS,
      instructions: `How useful is chunk ${k} for the goal — does it hold specific facts the agent would act on? Boilerplate, warnings, headers and command echoes are "irrelevant".`,
    };
  }
  const res = await evaluateJevWithAuth({
    state: { goal, output_chunks: items },
    questions: questions as never,
    timeoutMs: JEV_TRIM_TIMEOUT_MS,
  });
  const scores = chunks.map((_, i) => {
    const a = res.answers[`c${i}`] as { score?: number } | undefined;
    return typeof a?.score === "number" ? a.score : 0;
  });
  const lb = res.answers.lookback as { noul?: number } | undefined;
  return { scores, lookback: typeof lb?.noul === "number" ? lb.noul : 0 };
};

export function isJevTrimEligible(toolName: string, raw: string): boolean {
  return (
    JEV_TRIM_TOOLS.has(toolName) &&
    raw.length > JEV_TRIM_MIN_INPUT_CHARS &&
    raw.length <= JEV_TRIM_MAX_INPUT_CHARS
  );
}

/** Score a result. Returns null on failure so the caller keeps head+tail. */
export async function planJevTrim(
  raw: string,
  goal: string,
  scorer: TrimScorer = jevTrimScorer,
): Promise<JevTrimPlan | null> {
  const stripped = stripBashEnvelope(raw);
  const chunks = chunkByLines(stripped);
  if (chunks.length === 0) return null;
  const started = Date.now();
  try {
    const { scores, lookback } = await scorer(goal, chunks);
    return { chunks, scores, lookback, jevMs: Date.now() - started, strippedChars: stripped.length };
  } catch (error) {
    console.warn(
      "[JevToolTrim] scoring failed — head+tail fallback:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Per-turn cache of trim plans, keyed by toolCallId. Scoring starts when the
 * result lands (fire-and-forget); compaction awaits with a zero-wait check
 * so an unresolved plan means head+tail, never a stall.
 */
export interface JevTrimRegistry {
  arm: "treatment" | "control" | null;
  plans: Map<string, Promise<JevTrimPlan | null>>;
  settled: Map<string, JevTrimPlan | null>;
}

export function createJevTrimRegistry(arm: "treatment" | "control" | null): JevTrimRegistry {
  return { arm, plans: new Map(), settled: new Map() };
}

export function scheduleJevTrim(
  reg: JevTrimRegistry,
  toolCallId: string,
  toolName: string,
  raw: string,
  goal: string,
  scorer: TrimScorer = jevTrimScorer,
): void {
  if (reg.arm !== "treatment" || !isJevTrimEligible(toolName, raw)) return;
  if (reg.plans.has(toolCallId)) return;
  const p = planJevTrim(raw, goal, scorer);
  reg.plans.set(toolCallId, p);
  void p.then((plan) => reg.settled.set(toolCallId, plan));
}

/** Plan if already resolved; undefined while still in flight or not scheduled. */
export function settledJevTrim(
  reg: JevTrimRegistry | undefined,
  toolCallId: string | undefined,
): JevTrimPlan | null | undefined {
  if (!reg || !toolCallId) return undefined;
  return reg.settled.get(toolCallId);
}

export function trimBudgetFor(plan: JevTrimPlan): number {
  return plan.lookback >= JEV_TRIM_LOOKBACK_THRESHOLD
    ? JEV_TRIM_BUDGET_LOOKBACK
    : JEV_TRIM_BUDGET_DEFAULT;
}

/**
 * Best chunks (score ≥ minLevel) in original order, within `budget` chars of
 * body. The recovery suffix is appended on top: it is a fixed pointer cost
 * paid by head+tail too, and at the 400 tier it would otherwise consume
 * nearly half the budget.
 */
export function assembleJevTrim(
  plan: JevTrimPlan,
  budget: number,
  suffix: string,
  minLevel = JEV_TRIM_MIN_LEVEL,
): string {
  const sep = "\n[…]\n";
  const room = budget;
  const ranked = plan.chunks
    .map((_, i) => i)
    .filter((i) => (plan.scores[i] ?? 0) >= minLevel)
    .sort((a, b) => (plan.scores[b] ?? 0) - (plan.scores[a] ?? 0));
  const picked: number[] = [];
  let used = 0;
  for (const i of ranked) {
    const cost = plan.chunks[i].length + (picked.length ? sep.length : 0);
    if (used + cost > room) continue;
    picked.push(i);
    used += cost;
  }
  if (picked.length === 0) return "";
  picked.sort((a, b) => a - b);
  const body = picked.map((i) => plan.chunks[i]).join(sep);
  const dropped = plan.strippedChars - body.length;
  return body + `\n[… ${Math.max(0, dropped)} chars omitted by relevance]` + suffix;
}
