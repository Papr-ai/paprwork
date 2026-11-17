/**
 * papr-code-search v2.1: Jev reranks the code pointers.
 *
 * One Jev call per grep scores up to 20 candidates (the semantic top hits + the formula's own picks): "is this the
 * file the agent needs to read or edit for this request?". Pointers are Jev's top 3. On any failure (offline, no
 * login, slower than the budget, bad answer) the caller keeps the deterministic codeFusion ranking.
 *
 * Curation Bench (0.6B v1.0, desktop chunks, 50 grep misses + 25 controls): needed file in the 3 pointers
 * 33/50 -> 42/50 and 14/25 -> 16/25; ranked first 18 -> 31 and 5 -> 12. Jev p50 0.49 s, p90 0.76 s.
 */
import type { JevQuestion } from "./jevClient.js";

export const JEV_RERANK_MAX = 20; // JEV_MAX_QUESTIONS
export const JEV_RERANK_TIMEOUT_MS = 1_500;
const SNIPPET_CHARS = 900;
const REQUEST_CHARS = 1_200;

export interface RerankCandidate {
  path: string;
  /** The code Jev reads: best-matching chunk when known, else the head of the file. */
  snippet: string;
}

export interface RerankInput {
  candidates: RerankCandidate[];
  /** What the user asked for in this turn (the strongest signal; the formula never sees it). */
  userRequest?: string;
  query: string;
  command: string;
}

export type JevCaller = (args: {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  timeoutMs: number;
}) => Promise<{ answers: Record<string, unknown> }>;

export function jevRerankEnabled(): boolean {
  return process.env.PAPR_CODE_JEV_RERANK !== "0";
}

/** Code shown to Jev for one file: the lines of the best chunk, else the start of the file. */
export function snippetFor(text: string, lines?: { lineStart: number; lineEnd: number }): string {
  if (!lines) return text.slice(0, SNIPPET_CHARS);
  return text
    .split("\n")
    .slice(Math.max(0, lines.lineStart - 1), lines.lineEnd)
    .join("\n")
    .slice(0, SNIPPET_CHARS);
}

export function buildRerankRequest(input: RerankInput): {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
} {
  const cands = input.candidates.slice(0, JEV_RERANK_MAX);
  const state: Record<string, unknown> = {
    agent_is_looking_for: input.query.slice(0, 600),
    grep_command: input.command.slice(0, 300),
    candidates: Object.fromEntries(cands.map((c, i) => [`c${i}`, `${c.path}\n${c.snippet}`])),
  };
  if (input.userRequest?.trim()) state.user_request = input.userRequest.trim().slice(0, REQUEST_CHARS);
  const questions: Record<string, JevQuestion> = Object.fromEntries(
    cands.map((_, i) => [
      `c${i}`,
      {
        type: "noul" as const,
        instructions:
          `Is candidate c${i} the code file the agent needs to read or edit for this request ` +
          "(not a test, doc, or a file that only mentions the same words)?",
      },
    ]),
  );
  return { state, questions };
}

/** Jev probability per candidate path, best first; null when Jev is off, unreachable, slow or malformed. */
export async function jevRerank(
  input: RerankInput,
  call?: JevCaller,
  timeoutMs = JEV_RERANK_TIMEOUT_MS,
): Promise<Array<{ path: string; p: number }> | null> {
  if (!jevRerankEnabled() || input.candidates.length < 2) return null;
  const cands = input.candidates.slice(0, JEV_RERANK_MAX);
  try {
    const caller: JevCaller =
      call ??
      (async (a) => {
        const { evaluateJevWithAuth } = await import("./jevAuth.js");
        return evaluateJevWithAuth({ state: a.state, questions: a.questions, timeoutMs: a.timeoutMs });
      });
    const { state, questions } = buildRerankRequest({ ...input, candidates: cands });
    // Hard budget: the grep result never waits on Jev for longer than timeoutMs.
    const out = await Promise.race([
      caller({ state, questions, timeoutMs }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("jev rerank budget")), timeoutMs + 50)),
    ]);
    const scored = cands.map((c, i) => {
      const a = out.answers?.[`c${i}`] as { noul?: unknown } | undefined;
      return { path: c.path, p: typeof a?.noul === "number" ? a.noul : NaN };
    });
    if (scored.some((s) => !Number.isFinite(s.p))) return null;
    return scored.sort((a, b) => b.p - a.p);
  } catch (e) {
    console.warn("[Bash Tool] Jev rerank skipped:", (e as Error)?.message ?? e);
    return null;
  }
}
