/**
 * Nudge policy — when (and whether) your agent may lean out of the rail. Pure: no IO, no clock.
 *
 * Default answer is silence. A nudge only gets through when every rule below agrees:
 *
 *   rule                       why (evidence)
 *   ─────────────────────────  ─────────────────────────────────────────────────────────────────────
 *   ≤ 1 per day, ≤ 3 per week  Batching notifications into a few moments a day improves well-being
 *                              vs. delivering each one as it arrives (Fitz et al., CHB 2019).
 *   working hours, weekdays    Nudges are about work goals; off-hours pings are pure cost.
 *   min 20h gap, doubling on   Repeated alerts get overridden more and more (alert fatigue — Ancker
 *   every ignore (cap 7 days)  et al., BMC Med Inform 2017). Silence is a first-class action that
 *                              should win when the user has not engaged (When2Talk, arXiv 2026;
 *                              Proactive Service Agents, arXiv 2026).
 *   one key is shown once      Never re-pop the same thing. "Later" parks it as a still dot.
 *   "It's intentional" mutes   The user said the signal is wrong — respect it for a week.
 *   that kind for 7 days
 *   renderer: breakpoints only Deferring to task boundaries cuts frustration and resumption cost vs.
 *                              interrupting mid-task (Iqbal & Bailey, CHI 2008; Mark et al., CHI
 *                              2008; Okoshi et al., Attelia 2015). See useAgentNudge.ts.
 *   content: one fact + goal   Receptivity tracks content relevance more than timing (Mehrotra et
 *                              al., CHI 2016) — every nudge cites a number tied to a Focus goal.
 */

export type NudgeAction =
  | { type: "focus"; goalId?: string }
  | { type: "chat"; prompt: string }
  | { type: "app"; appId: string };

export interface NudgeCandidate {
  /** Stable identity — a key is shown at most once, ever. */
  key: string;
  /** Mute bucket ("drift", "due", or a job's own kind). */
  kind: string;
  line: string;
  sub?: string;
  go: string;
  later: string;
  /** Optional "the signal is wrong" answer; mutes this kind for MUTE_DAYS. */
  dismiss?: string;
  action: NudgeAction;
  /** 1 (nice to know) … 3 (slipping now). Highest wins. */
  priority: number;
  expiresAt?: string;
  /** Who proposed it: "focus" or a job id / name. */
  source: string;
}

export type NudgeOutcome = "go" | "later" | "dismiss";

export interface NudgeLedgerEntry {
  key: string;
  kind: string;
  at: string;
  outcome?: NudgeOutcome;
}

export interface NudgeLedger {
  version: 1;
  shown: NudgeLedgerEntry[];
  /** kind → ISO time the mute ends. */
  muted: Record<string, string>;
  /** Consecutive nudges without a "go". Drives the backoff. */
  unengaged: number;
}

export const NUDGE_RULES = {
  maxPerDay: 1,
  maxPerWeek: 3,
  minGapHours: 20,
  backoffCapDays: 7,
  muteDays: 7,
  /** Local hours [start, end). */
  windowStartHour: 9,
  windowEndHour: 18,
  weekends: false,
  keepDays: 60,
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const emptyLedger = (): NudgeLedger => ({ version: 1, shown: [], muted: {}, unengaged: 0 });

export type NudgeDecision =
  | { nudge: NudgeCandidate; reason: "ok" }
  | {
      nudge: null;
      reason: "weekend" | "quiet-hours" | "daily-cap" | "weekly-cap" | "cooldown" | "nothing-worth-it";
      retryAt?: string;
    };

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Required quiet time after the last nudge: 20h, doubled for every nudge the user did not act on. */
export function cooldownMs(ledger: NudgeLedger): number {
  const doublings = Math.max(0, ledger.unengaged - 1);
  return Math.min(NUDGE_RULES.minGapHours * HOUR * 2 ** doublings, NUDGE_RULES.backoffCapDays * DAY);
}

export function decideNudge(ledger: NudgeLedger, candidates: NudgeCandidate[], now: Date): NudgeDecision {
  const day = now.getDay();
  if (!NUDGE_RULES.weekends && (day === 0 || day === 6)) return { nudge: null, reason: "weekend" };
  const hour = now.getHours();
  if (hour < NUDGE_RULES.windowStartHour || hour >= NUDGE_RULES.windowEndHour) {
    return { nudge: null, reason: "quiet-hours" };
  }

  const t = now.getTime();
  const shown = ledger.shown.map((e) => ({ ...e, ms: Date.parse(e.at) })).filter((e) => Number.isFinite(e.ms));
  if (shown.filter((e) => sameLocalDay(new Date(e.ms), now)).length >= NUDGE_RULES.maxPerDay) {
    return { nudge: null, reason: "daily-cap" };
  }
  if (shown.filter((e) => t - e.ms < 7 * DAY).length >= NUDGE_RULES.maxPerWeek) {
    return { nudge: null, reason: "weekly-cap" };
  }
  const last = shown.reduce((m, e) => Math.max(m, e.ms), 0);
  if (last && t - last < cooldownMs(ledger)) {
    return { nudge: null, reason: "cooldown", retryAt: new Date(last + cooldownMs(ledger)).toISOString() };
  }

  const seen = new Set(ledger.shown.map((e) => e.key));
  const best = candidates
    .filter((c) => !seen.has(c.key))
    .filter((c) => !(ledger.muted[c.kind] && Date.parse(ledger.muted[c.kind]) > t))
    .filter((c) => !c.expiresAt || Date.parse(c.expiresAt) > t)
    .sort((a, b) => b.priority - a.priority)[0];
  return best ? { nudge: best, reason: "ok" } : { nudge: null, reason: "nothing-worth-it" };
}

export type NudgeEvent = { key: string; kind: string; event: "shown" | NudgeOutcome };

/** Record what happened. "shown" counts as unengaged until the user acts on it with "go". */
export function applyNudgeEvent(ledger: NudgeLedger, ev: NudgeEvent, now: Date): NudgeLedger {
  const t = now.getTime();
  const next: NudgeLedger = {
    version: 1,
    shown: ledger.shown.filter((e) => t - Date.parse(e.at) < NUDGE_RULES.keepDays * DAY),
    muted: Object.fromEntries(Object.entries(ledger.muted).filter(([, until]) => Date.parse(until) > t)),
    unengaged: ledger.unengaged,
  };
  if (ev.event === "shown") {
    if (next.shown.some((e) => e.key === ev.key)) return next; // reopening a parked nudge is not a new show
    next.shown.push({ key: ev.key, kind: ev.kind, at: now.toISOString() });
    next.unengaged += 1;
    return next;
  }
  const entry = next.shown.find((e) => e.key === ev.key);
  if (entry) entry.outcome = ev.event;
  if (ev.event === "go") next.unengaged = 0;
  if (ev.event === "dismiss") next.muted[ev.kind] = new Date(t + NUDGE_RULES.muteDays * DAY).toISOString();
  return next;
}

/** Validate a job-proposed candidate. Returns null for anything we would not show. */
export function sanitizeCandidate(raw: unknown, now: Date): NudgeCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const key = str(r.key, 120);
  const line = str(r.line, 90);
  const go = str(r.go, 28);
  const a = r.action as Record<string, unknown> | undefined;
  let action: NudgeAction | null = null;
  if (a?.type === "focus") action = { type: "focus", goalId: str(a.goalId, 40) };
  else if (a?.type === "chat" && str(a.prompt, 2000)) action = { type: "chat", prompt: str(a.prompt, 2000)! };
  else if (a?.type === "app" && str(a.appId, 80)) action = { type: "app", appId: str(a.appId, 80)! };
  if (!key || !line || !go || !action) return null;
  const expires = str(r.expiresAt, 40);
  const maxExpiry = now.getTime() + 3 * DAY;
  const expMs = expires ? Math.min(Date.parse(expires), maxExpiry) : now.getTime() + DAY;
  if (!Number.isFinite(expMs) || expMs <= now.getTime()) return null;
  return {
    key: `job:${key}`,
    kind: str(r.kind, 40) ?? "job",
    line,
    sub: str(r.sub, 110),
    go,
    later: str(r.later, 20) ?? "Later",
    dismiss: str(r.dismiss, 24),
    action,
    priority: Math.min(3, Math.max(1, Math.round(Number(r.priority) || 1))),
    expiresAt: new Date(expMs).toISOString(),
    source: str(r.source, 80) ?? "job",
  };
}
