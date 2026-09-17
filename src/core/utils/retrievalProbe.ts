/**
 * Randomised-exposure holdout for memory search (the "A13" probe).
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Agent-derived retrieval labels are confounded. The same agent that issued
 * the query also decided what to do with the results, and the ranking it saw
 * was produced by the very reranker we want to evaluate. So when a document is
 * cited we cannot separate:
 *
 *     "it was cited because it answered the query"        (relevance)
 *     "it was cited because it was placed at rank 0"      (exposure)
 *
 * Every estimator built on observational logs inherits that confound. It is not
 * reducible by collecting more logs — more data estimates the biased quantity
 * more precisely.
 *
 * THE FIX
 * -------
 * Randomise exposure on a small slice of traffic. When a search is assigned to
 * the `rerank_off` arm, the reranker is skipped and the agent sees raw
 * vector-similarity order instead. Arm assignment is independent of the query,
 * the corpus and the agent, so within the probe slice the rank a document
 * receives is exogenous. That gives exact propensities by construction and
 * makes unbiased estimation possible — the standard intervention behind
 * counterfactual learning-to-rank (Joachims et al., arXiv:1608.04468).
 *
 * COST
 * ----
 * The probe slice gets measurably worse results. That is the price, and it is
 * why the rate is 2% and configurable to 0. It is deliberately NOT applied when
 * the caller chose a reranking provider explicitly: overriding an explicit
 * argument would make the tool lie about what it did.
 *
 * INTERPRETATION WARNING
 * ----------------------
 * `probe` absent means "not assigned to any arm", which is NOT the control
 * arm. Only rows tagged `probe=control` are a valid comparison group for
 * `probe=rerank_off`; untagged rows predate the probe or opted out and carry
 * the original confound.
 */

export type RetrievalProbeArm = "rerank_off" | "control";

/** Fraction of eligible searches assigned to the randomised arm. */
export const DEFAULT_PROBE_RATE = 0.02;

/**
 * Control rows are what make the probe analysable, so we tag a matched slice
 * of ordinary searches too. Kept equal to the treatment rate: a control group
 * much larger than treatment buys precision we cannot use, because the
 * variance is dominated by the smaller arm.
 */
export const DEFAULT_CONTROL_RATE = 0.02;

function readRate(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) return fallback;
  const parsed = Number(envValue);
  // A malformed rate must not silently disable or max out the experiment.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export interface ProbeDecisionInput {
  /** True when the caller passed an explicit rerankingProvider. */
  callerChoseProvider: boolean;
  /** Injected for tests. Defaults to Math.random. */
  random?: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide this search's arm. Returns null when the search is not part of the
 * experiment — the common case.
 */
export function decideRetrievalProbeArm(
  input: ProbeDecisionInput,
): RetrievalProbeArm | null {
  if (input.callerChoseProvider) return null;

  const env = input.env ?? process.env;
  const probeRate = readRate(env.PAPR_RETRIEVAL_PROBE_RATE, DEFAULT_PROBE_RATE);
  const controlRate = readRate(
    env.PAPR_RETRIEVAL_CONTROL_RATE,
    DEFAULT_CONTROL_RATE,
  );
  if (probeRate <= 0 && controlRate <= 0) return null;

  const roll = (input.random ?? Math.random)();
  if (roll < probeRate) return "rerank_off";
  if (roll < probeRate + controlRate) return "control";
  return null;
}

/** Does this arm require suppressing the reranker? */
export function armDisablesReranking(arm: RetrievalProbeArm | null): boolean {
  return arm === "rerank_off";
}
