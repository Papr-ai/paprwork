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
 * for — switching providers mid-turn would need a different key. Within that
 * provider it only picks models the user has enabled and can reach
 * (config.autoAllowedModels, computed by the UI).
 */

import type { Provider, ReasoningEffort } from "../../../core/types/agents.js";

export const AUTO_MODEL_ID = "auto";
export const AUTO_ROUTE_TIMEOUT_MS = 2_500;
/** Below this confidence, round the tier UP: a misroute down is user-visible. */
export const AUTO_ROUTE_MIN_CONFIDENCE = 0.6;

import {
  AUTO_CAPABILITIES,
  DEFAULT_AUTO_LADDERS,
  ladderModelIds,
  pickLadderModel,
  type AutoCapability,
  type AutoLadder,
} from "../../../core/agents/autoLadders.js";

export { AUTO_CAPABILITIES, DEFAULT_AUTO_LADDERS };
export type { AutoCapability, AutoLadder };

export const AUTO_EFFORTS = ["low", "medium", "high"] as const;
export type AutoEffort = (typeof AUTO_EFFORTS)[number];

/** Kept for metrics/back-compat: the capability axis is what gets stored as tier. */
export type AutoTier = AutoCapability;

export interface AutoRung {
  model: string;
  effort?: ReasoningEffort;
}

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

/**
 * (capability, effort) → rung for this provider. `allowedModels` is the set
 * the user has enabled and can reach (sent by the UI); the rung is taken from
 * it when present. Null when there is no ladder or nothing on it is allowed.
 */
export function resolveAutoRung(
  provider: Provider,
  capability: AutoCapability,
  effort: AutoEffort = "medium",
  ladders: Partial<Record<Provider, AutoLadder>> = DEFAULT_AUTO_LADDERS,
  allowedModels?: readonly string[],
): AutoRung | null {
  const ladder = ladders[provider];
  if (!ladder) return null;
  const allowed = allowedModels?.length ? new Set(allowedModels) : undefined;
  const model = pickLadderModel(ladder, capability, allowed);
  if (!model) return null;
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
  allowedModels?: readonly string[],
): Promise<AutoRoutePick | null> {
  if (!ladders[provider]) return null;
  const decision = await evaluate(signals);
  if (!decision) return null;
  return {
    decision,
    rung: resolveAutoRung(
      provider,
      decision.capability,
      decision.effort,
      ladders,
      allowedModels,
    ),
  };
}

/**
 * Narrow Auto's allow-list to models that can read images, for turns that
 * carry an image. Without this, a short "fix this" + screenshot routes to a
 * basic rung (Haiku has no vision) and the image is silently dropped.
 * Returns `allowed` unchanged when no image is attached or when nothing on
 * the ladder can see — a blind answer beats a hard failure.
 */
export function visionAwareAllowedModels(
  provider: Provider,
  allowed: readonly string[] | undefined,
  hasImages: boolean,
  supportsVision: (provider: Provider, modelId: string) => boolean,
  ladders: Partial<Record<Provider, AutoLadder>> = DEFAULT_AUTO_LADDERS,
): readonly string[] | undefined {
  if (!hasImages) return allowed;
  const ladder = ladders[provider];
  const pool = allowed?.length ? allowed : ladder ? ladderModelIds(ladder) : [];
  const seeing = pool.filter((id) => supportsVision(provider, id));
  return seeing.length > 0 ? seeing : allowed;
}
