/**
 * Nudges — the one sentence your agent may offer from the rail, at most once a day.
 *
 * Sources (no new scheduled job, no LLM tokens):
 *   - Focus: computed on demand from the same local evidence as "Your three" (chat hours, due dates).
 *       due   — one of your three is due within 2 days and got < 1h this week
 *       drift — your #1 got < 15% of a week with ≥ 6h of chat time (once per goal per week)
 *   - Jobs: any job may POST /api/nudge/propose (e.g. the Home Daily Brief). Proposals queue here and
 *     pass through exactly the same policy — a job can suggest, it can never force.
 *
 * Persistence: workspace/nudges/ledger.json (what was shown + outcomes) and queue.json (proposals).
 * Policy (caps, quiet hours, backoff) lives in nudgePolicy.ts.
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import type { FocusState } from "./focusGoals.js";
import {
  applyNudgeEvent,
  decideNudge,
  emptyLedger,
  explainNudges,
  NUDGE_RULES,
  sanitizeCandidate,
  type NudgeCandidate,
  type NudgeDecision,
  type NudgeEvent,
  type NudgeExplain,
  type NudgeLedger,
} from "./nudgePolicy.js";

const DAY = 86_400_000;
const MAX_QUEUE = 20;

const dir = () => path.join(getPaprWorkspaceDir(), "nudges");
const ledgerPath = () => path.join(dir(), "ledger.json");
const queuePath = () => path.join(dir(), "queue.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function readLedger(): Promise<NudgeLedger> {
  const l = await readJson<NudgeLedger | null>(ledgerPath(), null);
  return l && Array.isArray(l.shown) ? { ...emptyLedger(), ...l } : emptyLedger();
}

/** One glanceable clause: "Close pre-seed Tranche 1 and build a pipeline…" → "Close pre-seed Tranche 1". */
export function shortGoal(title: string, max = 48): string {
  const head = title.split(/\s+(?:and|—|–|-|\|)\s+|[:;(]/)[0].trim() || title.trim();
  if (head.length <= max) return head;
  const cut = head.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max).trim()}…`;
}

const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${Math.round(h * 10) / 10}h`);

function dueInDays(due: string | undefined, now: Date): number | null {
  if (!due) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T23:59` : due);
  if (Number.isNaN(d.getTime())) return null;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.floor((d.getTime() - startToday) / DAY);
}

function isoWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}-W${Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7)}`;
}

/** Evidence-only candidates from Focus. Numbers, not nagging: one fact, why it matters, one move. */
export function focusNudgeCandidates(focus: Pick<FocusState, "three" | "weekHours">, now: Date): NudgeCandidate[] {
  const out: NudgeCandidate[] = [];
  focus.three.forEach((g, i) => {
    const days = dueInDays(g.due, now);
    const h = g.signals?.hours7 ?? 0;
    if (days === null || days < 0 || days > 2 || h >= 1) return;
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : new Date(now.getTime() + days * DAY).toLocaleDateString("en-US", { weekday: "long" });
    out.push({
      key: `due:${g.id}:${g.due}`,
      kind: "due",
      line: `${shortGoal(g.title)} is due ${when}.`,
      sub: h > 0 ? `${fmtH(h)} on it this week · #${i + 1} of your three` : `No time on it this week · #${i + 1} of your three`,
      go: "Open it",
      later: "Later",
      action: { type: "focus", goalId: g.id },
      priority: 3,
      source: "focus",
    });
  });

  const top = focus.three[0];
  const week = focus.weekHours ?? 0;
  const topH = top?.signals?.hours7 ?? 0;
  if (top && week >= 6 && topH < week * 0.15) {
    out.push({
      key: `drift:${top.id}:${isoWeek(now)}`,
      kind: "drift",
      line: `${shortGoal(top.title)} got ${fmtH(topH)} of your ${fmtH(week)} this week.`,
      sub: "It's your #1 focus",
      go: "Plan time for it",
      later: "Later",
      dismiss: "It's intentional",
      action: { type: "focus", goalId: top.id },
      priority: 2,
      source: "focus",
    });
  }
  return out;
}

async function readQueue(now: Date): Promise<NudgeCandidate[]> {
  const q = await readJson<NudgeCandidate[]>(queuePath(), []);
  return (Array.isArray(q) ? q : []).filter((c) => c?.expiresAt && Date.parse(c.expiresAt) > now.getTime());
}

async function allCandidates(now: Date): Promise<NudgeCandidate[]> {
  let focusCandidates: NudgeCandidate[] = [];
  try {
    const { getFocus } = await import("./focusGoals.js");
    focusCandidates = focusNudgeCandidates(await getFocus(), now);
  } catch {
    /* no focus evidence → no focus nudges */
  }
  return [...focusCandidates, ...(await readQueue(now))];
}

/** The one nudge allowed right now — or null with the reason (logged by the caller, never shown). */
export async function nextNudge(now = new Date()): Promise<NudgeDecision> {
  return decideNudge(await readLedger(), await allCandidates(now), now);
}

/** Dev tab: the decision, every candidate and why it would be skipped, plus the ledger. Read-only. */
export async function nudgeDebug(now = new Date()): Promise<NudgeExplain & { rules: typeof NUDGE_RULES; now: string }> {
  return { ...explainNudges(await readLedger(), await allCandidates(now), now), rules: NUDGE_RULES, now: now.toISOString() };
}

/** Dev tab: forget what was shown, the mutes and the backoff. Proposals in the queue stay. */
export async function resetNudgeLedger(): Promise<void> {
  await fs.rm(ledgerPath(), { force: true });
}

export async function recordNudgeEvent(ev: NudgeEvent, now = new Date()): Promise<NudgeLedger> {
  const next = applyNudgeEvent(await readLedger(), ev, now);
  await writeJson(ledgerPath(), next);
  return next;
}

/** A job suggests a nudge. Replaces an earlier proposal with the same key. */
export async function proposeNudge(raw: unknown, now = new Date()): Promise<NudgeCandidate> {
  const c = sanitizeCandidate(raw, now);
  if (!c) throw new Error("Invalid nudge: need key, line, go and action {type: focus|chat|app}");
  const queue = (await readQueue(now)).filter((q) => q.key !== c.key);
  queue.push(c);
  await writeJson(queuePath(), queue.slice(-MAX_QUEUE));
  return c;
}
