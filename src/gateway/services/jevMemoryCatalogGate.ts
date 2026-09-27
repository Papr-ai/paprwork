/**
 * Jev gate for the Papr memory catalog.
 *
 * The positional catalog (`slice(0, 8)` of tier 0/1 + 6 semantic matches)
 * costs ~1.1k tokens every turn-2 and, on a 59-turn replay, Jev rated ~98% of
 * those items "irrelevant" to the actual user message
 * (scripts/benchmark-jev-memory-catalog.mjs). This module scores every
 * candidate against the message and keeps only the ones at or above
 * `minLevel` (default 2 = "likely helps"), so the block is usually omitted
 * entirely and, when present, is 100–350 tokens of things that matter.
 *
 * Failure policy: any Jev error → return null and let the caller fall back to
 * the positional catalog. Measurement must never degrade the turn.
 */

import type { MemoryObject } from "@papr/memory/resources/shared.js";
import { GOAL_LEVELS } from "../../core/tools/pageExtract.js";

export const JEV_CATALOG_MIN_LEVEL = 2;
export const JEV_CATALOG_MAX_KEEP = 8;
export const JEV_CATALOG_BATCH = 12;
export const JEV_CATALOG_PREVIEW_CHARS = 300;
export const JEV_CATALOG_TIMEOUT_MS = 8_000;

export interface JevCatalogGateResult {
  kept: MemoryObject[];
  candidates: number;
  jevCalls: number;
  jevMs: number;
}

export type CatalogScorer = (
  userMessage: string,
  items: Record<string, string>,
) => Promise<Record<string, number>>;

function preview(m: MemoryObject): string {
  const text = (m.content ?? "").replace(/\s+/g, " ").trim();
  return `[${m.category ?? "memory"}] ${text.slice(0, JEV_CATALOG_PREVIEW_CHARS)}`;
}

/** Default scorer: Jev score questions via Papr proxy / BYOK. */
export const jevCatalogScorer: CatalogScorer = async (userMessage, items) => {
  const { evaluateJevWithAuth } = await import("../../core/tools/jevAuth.js");
  const keys = Object.keys(items);
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += JEV_CATALOG_BATCH) {
    batches.push(keys.slice(i, i + JEV_CATALOG_BATCH));
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const res = await evaluateJevWithAuth({
        state: {
          user_message: userMessage,
          memories: Object.fromEntries(batch.map((k) => [k, items[k]])),
        },
        questions: Object.fromEntries(
          batch.map((k) => [
            k,
            {
              type: "score" as const,
              criteria: GOAL_LEVELS,
              instructions: `Would memory ${k} help answer or act on the user's message? Generic workspace facts unrelated to this message are "irrelevant".`,
            },
          ]),
        ),
        timeoutMs: JEV_CATALOG_TIMEOUT_MS,
      });
      const scores: Record<string, number> = {};
      for (const k of batch) {
        const a = res.answers[k] as { score?: number } | undefined;
        scores[k] = typeof a?.score === "number" ? a.score : 0;
      }
      return scores;
    }),
  );
  return Object.assign({}, ...results);
};

/**
 * Score candidates and keep the ones Jev rates ≥ minLevel, best first.
 * Returns null on scorer failure so the caller can fall back.
 */
export async function gateCatalogWithJev(
  userMessage: string,
  candidates: MemoryObject[],
  options?: {
    scorer?: CatalogScorer;
    minLevel?: number;
    maxKeep?: number;
  },
): Promise<JevCatalogGateResult | null> {
  const seen = new Set<string>();
  const unique = candidates.filter((m) => {
    if (!m.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  if (unique.length === 0) {
    return { kept: [], candidates: 0, jevCalls: 0, jevMs: 0 };
  }

  const minLevel = options?.minLevel ?? JEV_CATALOG_MIN_LEVEL;
  const maxKeep = options?.maxKeep ?? JEV_CATALOG_MAX_KEEP;
  const scorer = options?.scorer ?? jevCatalogScorer;

  const keyed = unique.map((m, i) => [`m${i}`, m] as const);
  const items = Object.fromEntries(keyed.map(([k, m]) => [k, preview(m)]));

  const started = Date.now();
  let scores: Record<string, number>;
  try {
    scores = await scorer(userMessage, items);
  } catch (error) {
    console.warn(
      "[JevCatalogGate] scoring failed — falling back to positional catalog:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const jevMs = Date.now() - started;

  const kept = keyed
    .filter(([k]) => (scores[k] ?? 0) >= minLevel)
    .sort((a, b) => (scores[b[0]] ?? 0) - (scores[a[0]] ?? 0))
    .slice(0, maxKeep)
    .map(([, m]) => m);

  return {
    kept,
    candidates: unique.length,
    jevCalls: Math.ceil(unique.length / JEV_CATALOG_BATCH),
    jevMs,
  };
}
