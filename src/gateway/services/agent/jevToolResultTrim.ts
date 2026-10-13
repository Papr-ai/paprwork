/**
 * Jev-selected excerpts for stale bash results (experiment JEV_TOOL_TRIM).
 *
 * Why: get_full_tool_result is the #2 tool by volume (3.8k calls / 30d, 70%
 * of them paging back a *bash* result). A stale bash result is cut to 400
 * chars head+tail, which keeps the JSON envelope and the command echo — the
 * two least useful parts — and drops the middle, where the facts were.
 *
 * What: when a bash result over the 10K inline floor lands, strip the
 * envelope, split the whole output into ~500-char chunks (long lines split
 * too) and ask Jev, in parallel ≤20-question calls, how useful each chunk is
 * for what the agent was doing. When the result goes stale, compaction keeps
 * the top-scoring chunks plus the last one (exit codes, errors) within
 * JEV_TRIM_BUDGET chars instead of head+tail.
 *
 * Scope (Oct 2026 replay of 80 recovered results): under 10K, Jev excerpts
 * beat equal-length head+tail by only 3–8 points while recoveries cost about
 * what the cut saves, so those results stay whole. Only >10K outputs (logs,
 * dumps) are trimmed, where most of the text is noise.
 *
 * Latency: scoring starts when the tool returns and is awaited only at
 * compaction time, ≥3 model steps later. If it has not resolved by then, the
 * old head+tail path runs. Any Jev failure → old path.
 */

import { GOAL_LEVELS } from "../../../core/tools/pageExtract.js";
import { MID_TURN_INLINE_FLOOR_CHARS } from "./compactionPressure.js";

export const JEV_TOOL_TRIM_EXPERIMENT = "JEV_TOOL_TRIM";
export const JEV_TRIM_CHUNK_CHARS = 500;
export const JEV_TRIM_MAX_CHUNKS = 100; // 50K chars — covers the whole 40K max input
export const JEV_TRIM_MIN_LEVEL = 0; // rank only; budget decides how many survive
export const JEV_TRIM_LOOKBACK_THRESHOLD = 0.6;
/** Excerpt size. Replay: 3000 kept 46% of next-step identifiers vs 19% at 1500. */
export const JEV_TRIM_BUDGET = 3000;
/** Only results the inline floor would cut. */
export const JEV_TRIM_MIN_INPUT_CHARS = MID_TURN_INLINE_FLOOR_CHARS;
export const JEV_TRIM_MAX_INPUT_CHARS = 40_000;
// Scoring runs in the background and is only read ≥3 steps later, so a longer
// timeout costs no latency. Replay: batched calls take 1–3.5s, tail >8s.
export const JEV_TRIM_TIMEOUT_MS = 15_000;
/**
 * Jev guardrails allow 20 questions per call (JEV_MAX_QUESTIONS). One call
 * used to carry lookback + up to 48 chunk scores, so every result over ~19
 * chunks (~4K chars — i.e. every result compaction would actually cut) was
 * rejected client-side before any request. Batches run in parallel; the
 * first also carries the lookback question.
 */
export const JEV_TRIM_CHUNKS_PER_CALL = 19;
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

/** Line-aligned chunks of ≤size chars. Lines longer than size (minified JSON) are split. */
export function chunkByLines(text: string, size = JEV_TRIM_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (let line of text.split("\n")) {
    while (line.length > size) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(line.slice(0, size));
      line = line.slice(size);
    }
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

const LOOKBACK_QUESTION = {
  type: "noul",
  instructions:
    "The agent has already read this command output and moved on. Will it likely need to look back at specific facts in it later in this task (paths, ids, values, error text it must act on)? No if the output was a one-off check, confirmation, or mostly noise.",
};

/** Default scorer: chunk scores split into ≤20-question Jev calls, run in parallel. */
export const jevTrimScorer: TrimScorer = async (goal, chunks) => {
  const { evaluateJevWithAuth } = await import("../../../core/tools/jevAuth.js");
  const batches: number[][] = [];
  for (let i = 0; i < chunks.length; i += JEV_TRIM_CHUNKS_PER_CALL) {
    batches.push(
      chunks.slice(i, i + JEV_TRIM_CHUNKS_PER_CALL).map((_, j) => i + j),
    );
  }
  const results = await Promise.all(
    batches.map((idx, b) => {
      const items = Object.fromEntries(idx.map((i) => [`c${i}`, chunks[i]]));
      const questions: Record<string, unknown> = b === 0 ? { lookback: LOOKBACK_QUESTION } : {};
      for (const k of Object.keys(items)) {
        questions[k] = {
          type: "score",
          criteria: GOAL_LEVELS,
          instructions: `Does chunk ${k} contain specific facts (names, paths, ids, values, code, errors) the agent will need for its next action toward the goal? Boilerplate, warnings, headers and command echoes are "irrelevant".`,
        };
      }
      return evaluateJevWithAuth({
        state: { goal, output_chunks: items },
        questions: questions as never,
        timeoutMs: JEV_TRIM_TIMEOUT_MS,
      });
    }),
  );
  const answers: Record<string, unknown> = Object.assign({}, ...results.map((r) => r.answers));
  const scores = chunks.map((_, i) => {
    const a = answers[`c${i}`] as { score?: number } | undefined;
    return typeof a?.score === "number" ? a.score : 0;
  });
  const lb = answers.lookback as { noul?: number } | undefined;
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
  /** Goal for results scheduled lazily by compaction (paths without a tool-loop hook). */
  userMessage?: string;
  /** toolCallIds already counted as a fallback — compaction revisits every step. */
  fallbacksCounted: Set<string>;
}

export function createJevTrimRegistry(
  arm: "treatment" | "control" | null,
  userMessage?: string,
): JevTrimRegistry {
  return { arm, plans: new Map(), settled: new Map(), fallbacksCounted: new Set(), userMessage };
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

export function trimBudgetFor(_plan: JevTrimPlan): number {
  return JEV_TRIM_BUDGET;
}

/**
 * The last chunk (exit code, error, final summary) plus the best-scoring
 * others, in original order, within `budget` chars of body. The recovery
 * suffix is appended on top: it is a fixed pointer cost head+tail pays too.
 */
export function assembleJevTrim(
  plan: JevTrimPlan,
  budget: number,
  suffix: string,
  minLevel = JEV_TRIM_MIN_LEVEL,
): string {
  const sep = "\n[…]\n";
  const n = plan.chunks.length;
  if (n === 0) return "";
  const last = n - 1;
  const picked: number[] = [];
  let used = 0;
  if (plan.chunks[last].length <= budget) {
    picked.push(last);
    used = plan.chunks[last].length;
  }
  const ranked = plan.chunks
    .map((_, i) => i)
    .filter((i) => i !== last && (plan.scores[i] ?? 0) >= minLevel)
    .sort((a, b) => (plan.scores[b] ?? 0) - (plan.scores[a] ?? 0) || a - b);
  for (const i of ranked) {
    const cost = plan.chunks[i].length + (picked.length ? sep.length : 0);
    if (used + cost > budget) continue;
    picked.push(i);
    used += cost;
  }
  if (picked.length === 0) return "";
  picked.sort((a, b) => a - b);
  const body = picked.map((i) => plan.chunks[i]).join(sep);
  const dropped = plan.strippedChars - body.length;
  return body + `\n[… ${Math.max(0, dropped)} chars omitted by relevance]` + suffix;
}
