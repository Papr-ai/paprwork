/**
 * Auto model routing (Jev). One cheap `choice` call before the frontier
 * model runs classifies the turn into a tier; the tier maps to a concrete
 * (model, effort) rung on a per-provider ladder.
 *
 * Runs in two modes:
 *  - shadow: every turn, records what Auto *would* pick (turn_auto_* columns)
 *    while the user's explicit model runs. Lets us measure agreement and cost
 *    delta before anyone is routed.
 *  - applied: when the picker model is `auto`, the pick replaces config.model
 *    and config.reasoning for this turn only.
 *
 * Routing stays inside the provider the turn already resolved credentials
 * for — switching providers mid-turn would need a different key.
 */

import type { Provider, ReasoningEffort } from "../../../core/types/agents.js";

export const AUTO_MODEL_ID = "auto";
export const AUTO_ROUTE_TIMEOUT_MS = 2_500;
/** Below this confidence, round the tier UP: a misroute down is user-visible. */
export const AUTO_ROUTE_MIN_CONFIDENCE = 0.6;

export const AUTO_TIERS = ["trivial", "light", "standard", "deep", "hard"] as const;
export type AutoTier = (typeof AUTO_TIERS)[number];

export interface AutoRung {
  model: string;
  effort?: ReasoningEffort;
}

export type AutoLadder = Record<AutoTier, AutoRung>;

/**
 * Default ladders. Effort is only set on rungs whose model honours it
 * (Anthropic adaptive-thinking models, OpenAI reasoning models). Haiku 4.5 is
 * a budget-thinking model with no effort field.
 */
export const DEFAULT_AUTO_LADDERS: Partial<Record<Provider, AutoLadder>> = {
  anthropic: {
    trivial: { model: "claude-haiku-4-5" },
    light: { model: "claude-sonnet-5-5", effort: "low" },
    standard: { model: "claude-sonnet-5-5", effort: "medium" },
    deep: { model: "claude-sonnet-5-5", effort: "high" },
    hard: { model: "claude-opus-5-5", effort: "high" },
  },
  openai: {
    trivial: { model: "gpt-5.4-mini", effort: "low" },
    light: { model: "gpt-5.5", effort: "low" },
    standard: { model: "gpt-5.5", effort: "medium" },
    deep: { model: "gpt-5.5", effort: "high" },
    hard: { model: "gpt-5.5", effort: "high" },
  },
  "openai-codex": {
    trivial: { model: "gpt-5.4-mini", effort: "low" },
    light: { model: "gpt-5.5", effort: "low" },
    standard: { model: "gpt-5.5", effort: "medium" },
    deep: { model: "gpt-5.5", effort: "high" },
    hard: { model: "gpt-5.5", effort: "high" },
  },
  google: {
    trivial: { model: "gemini-3.5-flash-lite" },
    light: { model: "gemini-3.8-flash" },
    standard: { model: "gemini-3.8-flash" },
    deep: { model: "gemini-3.8-flash" },
    hard: { model: "gemini-3.1-pro-preview" },
  },
};

const TIER_CRITERIA: Record<AutoTier, string> = {
  trivial:
    "Greeting, acknowledgement, yes/no, or a one-line factual answer that needs no tools, no files, and no reasoning.",
  light:
    "Small, well-specified task: one lookup, one small edit, a short explanation, a quick status check. Little ambiguity.",
  standard:
    "Typical work: implement a described change, write or fix a script, answer a question that needs a few tool calls and some judgement.",
  deep:
    "Requires sustained reasoning: debugging an unclear failure, multi-file changes, analysis with trade-offs, or reading a lot of context before acting.",
  hard:
    "Architecture, design decisions, root-cause investigations across systems, long multi-step builds, or anything where a wrong answer is expensive.",
};

export interface AutoRouteSignals {
  userMessage: string;
  hasActivePlan?: boolean;
  hasActiveApp?: boolean;
  priorToolErrors?: number;
  /** Chars of prior conversation — long threads skew harder. */
  historyChars?: number;
}

export interface AutoRouteDecision {
  tier: AutoTier;
  /** Tier Jev picked before the confidence round-up. */
  rawTier: AutoTier;
  confidence: number;
  needsTools: boolean;
  jevMs: number;
}

export type AutoRouteEvaluator = (
  signals: AutoRouteSignals,
) => Promise<AutoRouteDecision | null>;

function tierIndex(tier: AutoTier): number {
  return AUTO_TIERS.indexOf(tier);
}

export function roundUpTier(tier: AutoTier, confidence: number): AutoTier {
  if (confidence >= AUTO_ROUTE_MIN_CONFIDENCE) return tier;
  const next = Math.min(tierIndex(tier) + 1, AUTO_TIERS.length - 1);
  return AUTO_TIERS[next]!;
}

function buildState(s: AutoRouteSignals): string {
  const flags: string[] = [];
  if (s.hasActivePlan) flags.push("an active multi-step plan is in progress");
  if (s.hasActiveApp) flags.push("a mini-app is open and being edited");
  if (s.priorToolErrors) flags.push(`${s.priorToolErrors} tool errors in the previous turn`);
  if (s.historyChars && s.historyChars > 40_000) flags.push("long conversation history");
  const ctx = flags.length ? `Context: ${flags.join("; ")}.\n` : "";
  return `${ctx}User message:\n${s.userMessage.slice(0, 2_000)}`;
}

/** Default evaluator: Jev via Papr proxy / BYOK. Null on any failure. */
export const jevAutoRouteEvaluator: AutoRouteEvaluator = async (signals) => {
  const started = Date.now();
  try {
    const { evaluateJevWithAuth } = await import("../../../core/tools/jevAuth.js");
    const res = await evaluateJevWithAuth({
      state: buildState(signals),
      questions: {
        tier: {
          type: "choice",
          instructions:
            "How much model capability does answering this message well require? Pick the lowest tier that would produce a correct, complete response.",
          criteria: TIER_CRITERIA,
        },
        needs_tools: {
          type: "noul",
          instructions:
            "Will a good response need to run tools (read files, search, execute commands, edit code, query data) rather than answer from the message alone?",
        },
      },
      timeoutMs: AUTO_ROUTE_TIMEOUT_MS,
    });
    const tierAns = res.answers.tier as
      | { choice?: string; confidence?: number }
      | undefined;
    // Noul answers are a 0..1 truth value (see jevToolResultTrim lookback).
    const toolsAns = res.answers.needs_tools as { noul?: number } | undefined;
    const rawTier = AUTO_TIERS.includes(tierAns?.choice as AutoTier)
      ? (tierAns!.choice as AutoTier)
      : "standard";
    const confidence = typeof tierAns?.confidence === "number" ? tierAns.confidence : 0;
    return {
      rawTier,
      tier: roundUpTier(rawTier, confidence),
      confidence,
      needsTools: (toolsAns?.noul ?? 0) >= 0.5,
      jevMs: Date.now() - started,
    };
  } catch {
    return null;
  }
};

/** Tier → rung for this provider. Null when the provider has no ladder. */
export function resolveAutoRung(
  provider: Provider,
  tier: AutoTier,
  ladders: Partial<Record<Provider, AutoLadder>> = DEFAULT_AUTO_LADDERS,
): AutoRung | null {
  const ladder = ladders[provider];
  return ladder ? ladder[tier] : null;
}

export interface AutoRoutePick {
  decision: AutoRouteDecision;
  rung: AutoRung | null;
}

/**
 * Route one turn. Never throws; null means "no decision" (Jev unavailable,
 * timeout, or provider without a ladder) and the caller keeps its config.
 */
export async function routeTurn(
  provider: Provider,
  signals: AutoRouteSignals,
  evaluate: AutoRouteEvaluator = jevAutoRouteEvaluator,
  ladders: Partial<Record<Provider, AutoLadder>> = DEFAULT_AUTO_LADDERS,
): Promise<AutoRoutePick | null> {
  if (!ladders[provider]) return null;
  const decision = await evaluate(signals);
  if (!decision) return null;
  return { decision, rung: resolveAutoRung(provider, decision.tier, ladders) };
}
