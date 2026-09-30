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

export const AUTO_CAPABILITIES = ["basic", "strong", "frontier"] as const;
export type AutoCapability = (typeof AUTO_CAPABILITIES)[number];

export const AUTO_EFFORTS = ["low", "medium", "high"] as const;
export type AutoEffort = (typeof AUTO_EFFORTS)[number];

/** Kept for metrics/back-compat: the capability axis is what gets stored as tier. */
export type AutoTier = AutoCapability;

export interface AutoRung {
  model: string;
  effort?: ReasoningEffort;
}

/**
 * Per-provider capability ladder. Effort is a separate axis: any rung whose
 * model honours a reasoning effort gets Jev's effort pick applied; the rest
 * (Haiku 4.5, Gemini) run without one. So Sonnet and Opus each have
 * low/medium/high, chosen independently of which model is picked.
 */
export interface AutoLadder {
  models: Record<AutoCapability, string>;
  /** Models on this ladder that accept a reasoning effort. */
  effortModels: ReadonlySet<string>;
}

export const DEFAULT_AUTO_LADDERS: Partial<Record<Provider, AutoLadder>> = {
  anthropic: {
    models: {
      basic: "claude-haiku-4-5",
      strong: "claude-sonnet-5-5",
      frontier: "claude-opus-5-5",
    },
    effortModels: new Set(["claude-sonnet-5-5", "claude-opus-5-5"]),
  },
  openai: {
    models: { basic: "gpt-5.4-mini", strong: "gpt-5.5", frontier: "gpt-5.5" },
    effortModels: new Set(["gpt-5.4-mini", "gpt-5.5"]),
  },
  "openai-codex": {
    models: { basic: "gpt-5.4-mini", strong: "gpt-5.5", frontier: "gpt-5.5" },
    effortModels: new Set(["gpt-5.4-mini", "gpt-5.5"]),
  },
  google: {
    models: {
      basic: "gemini-3.5-flash-lite",
      strong: "gemini-3.8-flash",
      frontier: "gemini-3.1-pro-preview",
    },
    effortModels: new Set(),
  },
};

const CAPABILITY_CRITERIA: Record<AutoCapability, string> = {
  basic:
    "A small, fast model is enough: greetings, acknowledgements, yes/no, one-line facts, trivial reformatting. No judgement calls.",
  strong:
    "Ordinary work: implement a described change, write or fix a script, look things up with a few tool calls, explain something. Some judgement, bounded scope.",
  frontier:
    "Needs the strongest model's judgement or breadth: architecture and design decisions, reviewing trade-offs, root-cause investigations across systems, nuanced writing, or anywhere a wrong answer is expensive.",
};

const EFFORT_CRITERIA: Record<AutoEffort, string> = {
  low: "Answer is mostly recall or a direct action; little step-by-step reasoning needed. Speed matters more than deliberation.",
  medium:
    "Some working-through required: a few steps of reasoning, checking a couple of things, modest ambiguity.",
  high: "Sustained reasoning: debugging unclear failures, multi-file changes, reconciling conflicting constraints, or long multi-step plans.",
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
  capability: AutoCapability;
  rawCapability: AutoCapability;
  capabilityConfidence: number;
  effort: AutoEffort;
  rawEffort: AutoEffort;
  effortConfidence: number;
  needsTools: boolean;
  jevMs: number;
}

export type AutoRouteEvaluator = (
  signals: AutoRouteSignals,
) => Promise<AutoRouteDecision | null>;

/** Below the confidence floor, round UP one step — a misroute down is user-visible. */
export function roundUp<T extends string>(
  scale: readonly T[],
  value: T,
  confidence: number,
): T {
  if (confidence >= AUTO_ROUTE_MIN_CONFIDENCE) return value;
  const next = Math.min(scale.indexOf(value) + 1, scale.length - 1);
  return scale[next]!;
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
        capability: {
          type: "choice",
          instructions:
            "Which model class does answering this message well require? Pick the lowest class that would produce a correct, complete response.",
          criteria: CAPABILITY_CRITERIA,
        },
        effort: {
          type: "choice",
          instructions:
            "How much step-by-step reasoning will a good response need, independent of which model answers?",
          criteria: EFFORT_CRITERIA,
        },
        needs_tools: {
          type: "noul",
          instructions:
            "Will a good response need to run tools (read files, search, execute commands, edit code, query data) rather than answer from the message alone?",
        },
      },
      timeoutMs: AUTO_ROUTE_TIMEOUT_MS,
    });
    type Choice = { choice?: string; confidence?: number } | undefined;
    const cap = res.answers.capability as Choice;
    const eff = res.answers.effort as Choice;
    // Noul answers are a 0..1 truth value (see jevToolResultTrim lookback).
    const toolsAns = res.answers.needs_tools as { noul?: number } | undefined;

    const rawCapability = AUTO_CAPABILITIES.includes(cap?.choice as AutoCapability)
      ? (cap!.choice as AutoCapability)
      : "strong";
    const capabilityConfidence = typeof cap?.confidence === "number" ? cap.confidence : 0;
    const rawEffort = AUTO_EFFORTS.includes(eff?.choice as AutoEffort)
      ? (eff!.choice as AutoEffort)
      : "medium";
    const effortConfidence = typeof eff?.confidence === "number" ? eff.confidence : 0;
    return {
      rawCapability,
      capability: roundUp(AUTO_CAPABILITIES, rawCapability, capabilityConfidence),
      capabilityConfidence,
      rawEffort,
      effort: roundUp(AUTO_EFFORTS, rawEffort, effortConfidence),
      effortConfidence,
      needsTools: (toolsAns?.noul ?? 0) >= 0.5,
      jevMs: Date.now() - started,
    };
  } catch {
    return null;
  }
};

/** (capability, effort) → rung for this provider. Null when no ladder. */
export function resolveAutoRung(
  provider: Provider,
  capability: AutoCapability,
  effort: AutoEffort = "medium",
  ladders: Partial<Record<Provider, AutoLadder>> = DEFAULT_AUTO_LADDERS,
): AutoRung | null {
  const ladder = ladders[provider];
  if (!ladder) return null;
  const model = ladder.models[capability];
  return ladder.effortModels.has(model) ? { model, effort } : { model };
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
  return {
    decision,
    rung: resolveAutoRung(provider, decision.capability, decision.effort, ladders),
  };
}
