/**
 * Data model behind the context meter.
 *
 * One question drives the whole surface: *is this turn about to run out of
 * room, and what did it cost?*
 *
 * Two provider-reported numbers answer it and they are not interchangeable:
 * the peak single-request context says how full the window got, while the
 * billed prompt total sums every step and says what it cost.
 */

import type { ContextInfo } from "./ContextInspectorModal";

export interface TurnUsage {
  messageId: string;
  model: string | null;
  timestamp: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  steps: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  compactionRuns: number | null;
  compactionSkips: number | null;
  recoveryFetches: number | null;
  redundantRecoveries: number | null;
  /** Largest single request in the turn — the window-fill number. */
  peakContextTokens: number | null;
  /** What the chars/4 estimator believed, for showing its drift. */
  estimatedContextTokens: number | null;
  contextBudgetTokens: number | null;
}

/**
 * The turn currently running. Present only while the agent is working, and
 * deliberately thinner than `TurnUsage`: cost and cache splits are not known
 * until the provider closes the turn, and inventing them mid-flight would put
 * a number on screen that later changes for no reason the user can see.
 */
export interface LiveTurn {
  model: string;
  startedAt: string;
  elapsedMs: number;
  steps: number;
  toolCalls: number;
  peakContextTokens: number;
}

export interface ContextMeter {
  model: string;
  provider: string;
  modelWindow: number;
  effectiveWindow: number;
  userCap: number | null;
  usedTokens: number;
  /**
   * Where fill came from. "live" is the turn in progress; "billed" means the
   * turn predates the peak measurement and the number is a per-step average,
   * so the UI says so rather than implying a precision it does not have.
   */
  fillSource: "live" | "measured" | "billed" | "none";
  liveTurn?: LiveTurn | null;
  lastTurn: TurnUsage | null;
  totals: {
    turns: number;
    cost: number;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
  };
}

export function isContextMeter(data: unknown): data is ContextMeter {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.effectiveWindow === "number" &&
    typeof record.usedTokens === "number" &&
    typeof record.model === "string"
  );
}

export type MeterStatus = "calm" | "warn" | "critical";

/** Thresholds, not a gradient: a dial that changes colour constantly says nothing. */
export function meterStatus(fraction: number): MeterStatus {
  if (fraction >= 0.9) return "critical";
  if (fraction >= 0.75) return "warn";
  return "calm";
}

/** Clamped for geometry — a ring cannot draw more than full. */
export function fillFraction(meter: ContextMeter): number {
  return Math.min(rawFillFraction(meter), 1);
}

/**
 * Unclamped, for the number the user reads.
 *
 * Over 100% is a real state, not an error: the last turn may have been
 * measured on a wider model than the one now selected, in which case the next
 * turn will not fit. Clamping that to "100%" would hide the one case where
 * the meter has something urgent to say.
 */
export function rawFillFraction(meter: ContextMeter): number {
  if (!meter.effectiveWindow) return 0;
  return meter.usedTokens / meter.effectiveWindow;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}K`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

/** Sub-cent turns are common; hiding them as "$0.00" makes the meter look broken. */
export function formatCost(cost: number): string {
  if (!cost) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export interface ContextSegment {
  id: string;
  label: string;
  tokens: number;
  /** Accent = the conversation itself. Neutral = machine overhead. */
  tone: "accent" | "accent-soft" | "accent-faint" | "neutral" | "neutral-soft";
  note?: string;
}

/**
 * Composition of the next prompt.
 *
 * Workspace files are already inside the system prompt, so they are split out
 * of it rather than added to it — the total has to stay the total.
 */
export function deriveSegments(info: ContextInfo): ContextSegment[] {
  const b = info.breakdown;
  const workspaceTokens = b.workspaceFiles?.tokens ?? 0;
  const systemOnly = Math.max(b.systemPrompt.tokens - workspaceTokens, 0);

  const segments: ContextSegment[] = [
    {
      id: "messages",
      label: "Conversation",
      tokens: b.messages.tokens,
      tone: "accent",
      note: `${b.messages.count ?? 0} messages`,
    },
    {
      id: "summary",
      label: "Summarized earlier turns",
      tokens: b.conversationSummary?.tokens ?? 0,
      tone: "accent-soft",
    },
    {
      id: "memory",
      label: "Papr memory",
      tokens: b.memoryBootstrap?.tokens ?? 0,
      tone: "accent-faint",
    },
    {
      id: "tools",
      label: "Tool definitions",
      tokens: b.tools.tokens,
      tone: "neutral",
      note: `${b.tools.count ?? 0} tools`,
    },
    {
      id: "system",
      label: "System prompt",
      tokens: systemOnly,
      tone: "neutral",
    },
    {
      id: "workspace",
      label: "Workspace rules",
      tokens: workspaceTokens,
      tone: "neutral-soft",
      note: `${b.workspaceFiles?.count ?? 0} files`,
    },
    {
      id: "focus",
      label: "Focus context",
      tokens: b.focusContext?.tokens ?? 0,
      tone: "neutral-soft",
    },
  ];

  return segments
    .filter((segment) => segment.tokens > 0)
    .sort((a, b2) => b2.tokens - a.tokens);
}
