/**
 * Architect triage — decides whether a new mini-app needs the full
 * product-architect sub-agent or a "lite" pass the main agent does inline.
 *
 * Why: the full architect (schema, job DAG, read budget, ACL…) is ~2 min and
 * thousands of tokens. For a single-screen visual, calculator, or one-off
 * analysis report that is pure overhead. But under-planning a shared-DB,
 * multi-user, scheduled-job app is expensive to undo — so the policy is
 * asymmetric: lite only when Jev is confident AND no risk signal fires.
 *
 * Decision = Jev (typed judgments) + deterministic veto (regex) in code.
 * Jev never writes the brief; it only classifies. Any Jev failure → "full".
 *
 * Enforcement: a lite pass unlocks create_app ONLY. create_job for app-linked,
 * scheduled, dependent, or agent jobs still requires the full architect, so an
 * app that grows backend needs is escalated automatically by the gate.
 */

import { DESIGN_DIRECTIVE_BLOCK } from "../constants/designDirective.js";
import type { JevQuestion } from "../tools/jevClient.js";

export type ArchitectTier = "full" | "lite";

/** Marker persisted in the tool result — the create_app gate scans for it. */
export const ARCHITECT_TRIAGE_TOOL_ID = "architect_triage";
export const ARCHITECT_TRIAGE_MARKER = "architectTriageTier";

export const LITE_MIN_PROBABILITY = 0.75;
export const RISK_MAX_PROBABILITY = 0.5;
const STATE_MAX_CHARS = 4_000;

/** Risk questions — any "yes" above RISK_MAX_PROBABILITY forces full. */
export const ARCHITECT_RISK_QUESTIONS = {
  background_work: "Does this need background jobs, schedules, recurring syncs, scraping, or AI agents running outside the page?",
  multi_user: "Will more than one person use it with their own data, roles, sharing, or admin-only views?",
  data_model: "Does it need a database schema with several related tables, or data shared with jobs or other apps?",
  external_integrations: "Does it call external APIs or services that need API keys, OAuth, webhooks, or email/notifications?",
} as const;

export type ArchitectRiskKey = keyof typeof ARCHITECT_RISK_QUESTIONS;

/** Deterministic veto — cheap, explainable, catches what Jev might miss. */
const VETO_PATTERNS: Array<[string, RegExp]> = [
  ["schedule/background", /\b(schedul\w*|cron|every (hour|day|week|morning|night)|daily|hourly|weekly|recurring|background job|pipeline|scrap\w*|crawl\w*|monitor\w*|auto-?sync)\b/i],
  ["multi-user/access", /\b(multi-?user|team(mates)?|roles?|admins?|permissions?|acl|share[ds]? with|login|sign[- ]?in|collaborat\w*|each user|per-user)\b/i],
  ["integrations", /\b(api key|oauth|webhook|stripe|slack|gmail|hubspot|salesforce|notion|twitter|linkedin|reddit|send (an )?email|notif\w*)\b/i],
  ["data platform", /\b(turso|shared (db|database)|migrations?|sync(ed)? database|multiple tables)\b/i],
];

export interface ArchitectTriageDecision {
  tier: ArchitectTier;
  liteProbability: number;
  risks: Partial<Record<ArchitectRiskKey, number>>;
  vetoes: string[];
  reason: string;
}

function readProbability(answer: unknown, option?: string): number | null {
  if (!answer || typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  if (option) {
    const probs = a.probabilities as Record<string, number> | undefined;
    if (probs && typeof probs[option] === "number") return probs[option];
    if (a.choice === option && typeof a.confidence === "number") return a.confidence;
    if (typeof a.choice === "string") return a.choice === option ? 0.5 : 0;
    return null;
  }
  if (typeof a.noul === "number") return a.noul;
  if (typeof a.probability === "number") return a.probability;
  return null;
}

export function findVetoes(text: string): string[] {
  return VETO_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/** Pure decision — unit-testable without Jev. */
export function decideArchitectTier(
  answers: Record<string, unknown> | null,
  requestText: string,
): ArchitectTriageDecision {
  const vetoes = findVetoes(requestText);
  if (!answers) {
    return { tier: "full", liteProbability: 0, risks: {}, vetoes, reason: "Jev unavailable — defaulting to full architect" };
  }
  const liteProbability = readProbability(answers.tier, "lite") ?? 0;
  const risks: Partial<Record<ArchitectRiskKey, number>> = {};
  const riskHits: string[] = [];
  for (const key of Object.keys(ARCHITECT_RISK_QUESTIONS) as ArchitectRiskKey[]) {
    // Missing risk answer counts as risky (fail closed).
    const p = readProbability(answers[key]) ?? 1;
    risks[key] = p;
    if (p > RISK_MAX_PROBABILITY) riskHits.push(key);
  }

  if (vetoes.length) {
    return { tier: "full", liteProbability, risks, vetoes, reason: `Risk keywords: ${vetoes.join(", ")}` };
  }
  if (riskHits.length) {
    return { tier: "full", liteProbability, risks, vetoes, reason: `Jev flagged: ${riskHits.join(", ")}` };
  }
  if (liteProbability < LITE_MIN_PROBABILITY) {
    return { tier: "full", liteProbability, risks, vetoes, reason: `Lite confidence ${liteProbability.toFixed(2)} < ${LITE_MIN_PROBABILITY}` };
  }
  return { tier: "lite", liteProbability, risks, vetoes, reason: "Single-screen frontend / report with no backend, multi-user, or integration needs" };
}

export function buildArchitectTriageJevInput(request: string, context?: string) {
  const state = { request: request.slice(0, STATE_MAX_CHARS), context: (context ?? "").slice(0, STATE_MAX_CHARS) };
  const questions: Record<string, JevQuestion> = {
    tier: {
      type: "choice",
      instructions: "How much up-front product/architecture planning does building this mini-app need?",
      criteria: {
        lite: "A single-purpose frontend: one screen or a few static views, a visualization, calculator, landing page, or a one-off analysis/report. At most one simple local table. No jobs, no multi-user, no integrations.",
        full: "An app+system: background or scheduled jobs, multiple related tables or shared data, multi-user roles/sharing, external APIs/keys, pipelines, or several distinct workflows.",
      },
    },
  };
  for (const [key, instructions] of Object.entries(ARCHITECT_RISK_QUESTIONS)) {
    questions[key] = { type: "noul", instructions };
  }
  return { state, questions };
}

/** Rules the main agent applies itself on the lite path (no sub-agent). */
export const LITE_ARCHITECT_BRIEF =
  "LITE ARCHITECT PASS — build directly, no product-architect delegation.\n" +
  "Before create_app, write a 5-line brief in chat: (1) the one job-to-be-done, (2) the primary action, " +
  "(3) EMPTY state copy + CTA, (4) FILLED state hierarchy (key number first), (5) dark/light + 390px/1440px notes.\n" +
  "Frontend rules:\n" +
  "- read_skill({ skillId: \"preloaded-paprwork-design-system\" }) before UI code; no emojis; one page unless tabs are truly needed\n" +
  "- Reports/analysis: long prose in content/reports/*.md, rendered by the app — not split across TS files\n" +
  "- If it reads data: /api/db/query with { sourceId, sql, params } on an attached DB; skeleton loading + empty + error states\n" +
  "- validate_app + webview preview in both color schemes after create_app\n" +
  "ESCALATE: if you discover it needs jobs, schedules, multi-user/ACL, shared DB, or API keys — stop and delegate_task({ useAgentId: \"product-architect\" }). " +
  "create_job for app-linked/scheduled/agent jobs stays blocked until the full architect runs.\n\n" +
  `Design Directive:\n${DESIGN_DIRECTIVE_BLOCK}`;

/** Does a stored tool call record a lite (or full) triage? Robust to run_deferred_tool wrapping and string results. */
export function readTriageTierFromToolCall(toolCall: {
  name?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}): ArchitectTier | null {
  const name = toolCall.name ?? toolCall.toolName;
  const viaDeferred = name === "run_deferred_tool" && toolCall.args?.tool_name === ARCHITECT_TRIAGE_TOOL_ID;
  if (name !== ARCHITECT_TRIAGE_TOOL_ID && !viaDeferred) return null;
  const raw = typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result ?? "");
  const m = raw.match(new RegExp(`${ARCHITECT_TRIAGE_MARKER}\\\\*"\\s*:\\s*\\\\*"(lite|full)`));
  return m ? (m[1] as ArchitectTier) : null;
}
