import { useCallback, useEffect, useState } from "react";
import {
  summarizeClaudePlanUsage,
  summarizeCodexPlanUsage,
  type PlanProvider,
  type PlanUsageSummary,
} from "../../../utils/subscriptionPlanUsage";
import { guessChatGptPlan, guessClaudePlan, type PlanPriceGuess } from "../../../utils/planPricing";

export interface PlanReading {
  provider: PlanProvider;
  summary: PlanUsageSummary;
  plan: PlanPriceGuess | null;
  /** Billed past the plan's limits this month (Claude extra usage). */
  extraSpentUsd: number | null;
  /** ChatGPT prepaid credit balance, shown as context only. */
  creditBalance: string | null;
  resets: { session: string | null; weekly: string | null };
}

const MIN_INTERVAL_MS = 60_000;
let cache: { at: number; value: PlanReading[] } | null = null;

function resetOf(rows: Array<{ id: string; resetsAt?: string | null }>, prefix: string): string | null {
  return rows.find((r) => r.id.startsWith(prefix))?.resetsAt ?? null;
}

async function readClaude(): Promise<PlanReading | null> {
  const res = await window.electronAPI?.oauth?.claude?.getUsageLimits?.();
  if (!res?.success || !res.data) return null;
  const d = res.data;
  const spent = d.extraUsageSpent;
  return {
    provider: "anthropic",
    summary: summarizeClaudePlanUsage(d),
    plan: guessClaudePlan({ ...d.plan, subscriptionType: d.subscriptionType }),
    extraSpentUsd: spent && spent.currency === "USD" ? spent.amount : null,
    creditBalance: null,
    resets: { session: resetOf(d.rows, "session"), weekly: resetOf(d.rows, "weekly_all") },
  };
}

async function readChatGpt(): Promise<PlanReading | null> {
  const res = await window.electronAPI?.oauth?.openai?.getUsageLimits?.();
  if (!res?.success || !res.data) return null;
  const d = res.data;
  return {
    provider: "openai",
    summary: summarizeCodexPlanUsage(d),
    plan: guessChatGptPlan(d.subscriptionType),
    extraSpentUsd: null,
    creditBalance: d.creditBalance ?? null,
    resets: {
      session: d.rows[0]?.resetsAt ?? null,
      weekly: d.rows[1]?.resetsAt ?? null,
    },
  };
}

/** Plan readings for every connected subscription. Not polled — read on open. */
export function usePlanUsage(visible: boolean) {
  const [plans, setPlans] = useState<PlanReading[] | null>(cache?.value ?? null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (force = false) => {
    if (!force && cache && Date.now() - cache.at < MIN_INTERVAL_MS) {
      setPlans(cache.value);
      return;
    }
    setLoading(true);
    try {
      const settled = await Promise.allSettled([readClaude(), readChatGpt()]);
      const value = settled
        .map((s) => (s.status === "fulfilled" ? s.value : null))
        .filter((p): p is PlanReading => p !== null);
      cache = { at: Date.now(), value };
      setPlans(value);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  return { plans, loading, reload: () => load(true) };
}
