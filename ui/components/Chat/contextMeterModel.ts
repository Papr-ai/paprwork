/**
 * Data model behind the context meter.
 *
 * One question drives the whole surface: *is this turn about to run out of
 * room, and what did it cost?* Fill comes from the provider's own
 * `prompt_tokens`, not an estimate, so the dial and the invoice agree.
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
  peakContextTokens: number | null;
  contextBudgetTokens: number | null;
}

export interface ContextMeter {
  model: string;
  provider: string;
  modelWindow: number;
  effectiveWindow: number;
  userCap: number | null;
  usedTokens: number;
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

export function fillFraction(meter: ContextMeter): number {
  if (!meter.effectiveWindow) return 0;
  return Math.min(meter.usedTokens / meter.effectiveWindow, 1);
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
