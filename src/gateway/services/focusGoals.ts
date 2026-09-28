/**
 * Focus — "Your three". Pen picks the three goals that matter most right now; the user can keep,
 * edit or swap them at any time. If the user never touches them, Pen's picks are quietly accepted.
 *
 * Candidates
 *   - IDENTITY.md `## Goals` (canonical; block or one-line bullet format) — active goals only
 *   - Papr onboarding Goals/OKRs + Use cases (Parse `Goal` / `Usecase`) — boost a matching
 *     IDENTITY goal, or become their own candidate when nothing matches
 *
 * Evidence (all local, read-only — no network except the optional Parse lookup)
 *   - chats.db: chats touched in the last 30 days, matched by title + summary topics; hours from
 *     `turn_duration_ms` (the same number Amplitude receives as agent-turn duration)
 *   - workspace/memory daily logs (last 14 days): goal id or keyword hits
 *   - wiki + tasks projection: open tasks per goal and the next due date
 *   - apps.json: goal-linked apps opened in the last 7 days
 *
 * Persistence: workspace/goals/focus.json (never IDENTITY.md — goals stay agent-owned there).
 * Pen never reshuffles a saved three; a slot is only refilled when its goal is closed or removed.
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprDataDir, getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { resolvePaprUserDataPath } from "../../core/utils/paprWorkspace.js";
import { readWorkspaceGoals, type WorkspaceGoal } from "./workspaceGoals.js";
import {
  scoreFocusCandidates,
  goalKeywords,
  buildIdf,
  matchScore,
  type ActivityChat,
  type ActivityApp,
  type ActivityLog,
  type ActivityTask,
  type FocusCandidateInput,
  type FocusGoal,
  type ScoredActivity,
} from "./focusGoalsScoring.js";

export type { FocusGoal } from "./focusGoalsScoring.js";

export interface FocusPick {
  /** Stable slot id: the goal id (G1…) or `F-<ts>` for a goal the user wrote. */
  id: string;
  goalId?: string;
  title?: string;
  target?: string;
  due?: string;
}

interface FocusFile {
  version: 1;
  source: "pen" | "user";
  pickedAt: string;
  confirmedAt?: string | null;
  picks: FocusPick[];
}

export interface FocusState {
  three: FocusGoal[];
  /** Ranked goals outside the three — the swap list. */
  candidates: FocusGoal[];
  source: "pen" | "user";
  confirmed: boolean;
  pickedAt: string;
  /** Share of this week's chat hours that went to the three (null when there is too little to say). */
  alignedPct: number | null;
  weekHours: number;
  next: { title: string; goalId: string; due?: string } | null;
  /** "From 38 chats and your daily logs since Sep 1". */
  evidence: string;
}

const MAX_PICKS = 3;
const DAY = 86_400_000;

function focusPath(): string {
  return path.join(getPaprWorkspaceDir(), "goals", "focus.json");
}

async function readFocusFile(): Promise<FocusFile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(focusPath(), "utf8")) as FocusFile;
    return Array.isArray(raw?.picks) ? raw : null;
  } catch {
    return null;
  }
}

async function writeFocusFile(file: FocusFile): Promise<void> {
  await fs.mkdir(path.dirname(focusPath()), { recursive: true });
  const tmp = `${focusPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmp, focusPath());
}

// ---------- evidence readers (each fails soft to "no signal") ----------

async function readChats(now: number): Promise<{ chats: ActivityChat[]; corpus: string[] }> {
  const file = path.join(resolvePaprUserDataPath(), "chats.db");
  try {
    await fs.access(file);
  } catch {
    return { chats: [], corpus: [] };
  }
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const since30 = new Date(now - 30 * DAY).toISOString();
    const since7 = new Date(now - 7 * DAY).toISOString();
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.summary_topics AS topics, c.summary_short AS summary, c.updated_at AS updatedAt,
                COALESCE(SUM(CASE WHEN m.timestamp >= @since7 THEN m.turn_duration_ms END), 0) AS ms7,
                COALESCE(SUM(m.turn_duration_ms), 0) AS ms30
           FROM chats c
           LEFT JOIN messages m ON m.chat_id = c.id AND m.role = 'assistant' AND m.timestamp >= @since30
          WHERE c.updated_at >= @since30 AND c.id NOT LIKE 'job:%' AND c.id NOT LIKE 'delegation:%'
          GROUP BY c.id`,
      )
      .all({ since30, since7 }) as Array<{
      id: string;
      title: string | null;
      topics: string | null;
      summary: string | null;
      updatedAt: string;
      ms7: number;
      ms30: number;
    }>;
    const corpus = (
      db
        .prepare(
          `SELECT title, summary_topics AS topics FROM chats
            WHERE id NOT LIKE 'job:%' AND id NOT LIKE 'delegation:%' ORDER BY updated_at DESC LIMIT 2000`,
        )
        .all() as Array<{ title: string | null; topics: string | null }>
    ).map((r) => `${r.title ?? ""} ${r.topics ?? ""}`);
    const chats = rows.map((r) => ({
      id: r.id,
      text: [r.title, r.topics, r.summary].filter(Boolean).join(" \n "),
      updatedAt: r.updatedAt,
      hours7: r.ms7 / 3_600_000,
      hours30: r.ms30 / 3_600_000,
    }));
    return { chats, corpus };
  } finally {
    db.close();
  }
}

async function readDailyLogs(now: number): Promise<ActivityLog[]> {
  const dir = path.join(getPaprWorkspaceDir(), "memory");
  const cutoff = new Date(now - 14 * DAY).toISOString().slice(0, 10);
  try {
    const names = (await fs.readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n) && n.slice(0, 10) >= cutoff);
    return Promise.all(names.map(async (n) => ({ date: n.slice(0, 10), text: await fs.readFile(path.join(dir, n), "utf8") })));
  } catch {
    return [];
  }
}

async function readOpenTasks(): Promise<ActivityTask[]> {
  try {
    const { readWorkspaceTasks } = await import("./workspaceTasks.js");
    const res = await readWorkspaceTasks({ status: "open" });
    return res.tasks.map((t) => ({ title: t.title, goalId: t.goal_id ?? undefined, due: t.due ?? undefined }));
  } catch {
    return [];
  }
}

async function readApps(now: number): Promise<ActivityApp[]> {
  try {
    const list = JSON.parse(await fs.readFile(path.join(getPaprDataDir(), "apps.json"), "utf8")) as Array<{
      title?: string;
      lastOpenedAt?: string;
    }>;
    const since = now - 7 * DAY;
    return list
      .filter((a) => a.title && a.lastOpenedAt && Date.parse(a.lastOpenedAt) >= since)
      .map((a) => ({ title: a.title as string }));
  } catch {
    return [];
  }
}

let onboardingCache: { at: number; items: FocusCandidateInput[] } | null = null;

/** Papr onboarding goals/OKRs + use cases (Parse). Optional: 3.5s budget, cached 30 min. */
async function readOnboardingGoals(): Promise<FocusCandidateInput[]> {
  if (onboardingCache && Date.now() - onboardingCache.at < 30 * 60_000) return onboardingCache.items;
  const items: FocusCandidateInput[] = [];
  try {
    const [{ getApiKey }, { getPaprUserId }, parse] = await Promise.all([
      import("../utils/keyResolver.js"),
      import("../utils/paprUserId.js"),
      import("../utils/parseUserContext.js"),
    ]);
    const token = await getApiKey("PAPR_SESSION_TOKEN");
    const userId = getPaprUserId();
    if (token && userId) {
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500));
      const [goals, usecases] = await Promise.race([
        Promise.all([parse.fetchParseGoalsForUser(token, userId), parse.fetchParseUsecasesForUser(token, userId)]),
        timeout,
      ]);
      for (const g of goals) if (g.title?.trim()) items.push({ id: `P-${g.objectId}`, title: g.title.trim(), origin: "onboarding", detail: g.description });
      for (const u of usecases) if (u.name?.trim()) items.push({ id: `U-${u.objectId}`, title: u.name.trim(), origin: "usecase", detail: u.description });
    }
  } catch {
    /* offline / signed out — onboarding is a bonus signal, never required */
  }
  onboardingCache = { at: Date.now(), items };
  return items;
}

// ---------- assembly ----------

function toInput(g: WorkspaceGoal): FocusCandidateInput {
  return {
    id: g.id,
    title: g.title,
    origin: "identity",
    level: g.level,
    status: g.status,
    confidence: g.confidence,
    priority: g.priority,
    parent: g.parent,
    entities: g.entities,
    mentions: g.mentions,
    nextMilestone: g.nextMilestone,
    chatRefs: g.chatRefs,
  };
}

/** Rank every candidate against today's evidence without touching focus.json (diagnostics + tests). */
export async function rankFocusCandidates(now = Date.now()): Promise<ScoredActivity> {
  const [goalsRes, { chats, corpus }, logs, tasks, apps, onboarding] = await Promise.all([
    readWorkspaceGoals(),
    readChats(now).catch((err) => {
      console.warn("[focus] chats.db unreadable:", err instanceof Error ? err.message : err);
      return { chats: [] as ActivityChat[], corpus: [] as string[] };
    }),
    readDailyLogs(now),
    readOpenTasks(),
    readApps(now),
    readOnboardingGoals(),
  ]);
  const active = goalsRes.goals.filter((g) => g.status !== "done" && g.status !== "dropped");
  return scoreFocusCandidates({ goals: active.map(toInput), onboarding, chats, corpus, logs, tasks, apps, now });
}

function applyPick(pick: FocusPick, byId: Map<string, FocusGoal>): FocusGoal | null {
  const base = pick.goalId ? byId.get(pick.goalId) : undefined;
  if (pick.goalId && !base) return null; // goal closed or removed → slot needs a refill
  if (!base) {
    if (!pick.title) return null;
    return {
      id: pick.id,
      title: pick.title,
      target: pick.target,
      due: pick.due,
      origin: "custom",
      why: "Written by you",
      score: 0,
      signals: { chats30: 0, hours7: 0, hours30: 0, logDays: 0, openTasks: 0, appsOpened: 0 },
    };
  }
  return { ...base, id: pick.id, title: pick.title || base.title, target: pick.target ?? base.target, due: pick.due ?? base.due };
}

/** Resolve the saved three against today's evidence; first run quietly saves Pen's picks. */
export async function getFocus(now = Date.now()): Promise<FocusState> {
  const scored = await rankFocusCandidates(now);
  const byId = new Map(scored.ranked.map((g) => [g.id, g]));
  let file = await readFocusFile();
  let dirty = false;
  if (!file || file.picks.length === 0) {
    file = {
      version: 1,
      source: "pen",
      pickedAt: new Date(now).toISOString(),
      confirmedAt: null,
      picks: scored.top.map((g) => ({ id: g.id, goalId: g.id })),
    };
    dirty = file.picks.length > 0;
  }
  const three: FocusGoal[] = [];
  const keptPicks: FocusPick[] = [];
  for (const pick of file.picks.slice(0, MAX_PICKS)) {
    const g = applyPick(pick, byId);
    if (g) {
      three.push(g);
      keptPicks.push(pick);
    } else dirty = true;
  }
  // Refill empty slots (closed/removed goals) from the next best candidates.
  for (const g of scored.top.concat(scored.ranked)) {
    if (three.length >= MAX_PICKS) break;
    if (three.some((t) => t.id === g.id || t.id === g.parent || t.parent === g.id)) continue;
    three.push(g);
    keptPicks.push({ id: g.id, goalId: g.id });
    dirty = true;
  }
  if (dirty && keptPicks.length) {
    file = { ...file, picks: keptPicks };
    await writeFocusFile(file).catch((err) => console.warn("[focus] could not save picks:", err));
  }
  const chosen = new Set(three.map((g) => g.id));
  const candidates = scored.ranked.filter((g) => !chosen.has(g.id)).slice(0, 6);
  const alignedHours = scored.hoursFor(three.map((g) => g.id));
  const next = pickNext(three, scored);
  return {
    three,
    candidates,
    source: file.source,
    confirmed: Boolean(file.confirmedAt),
    pickedAt: file.pickedAt,
    alignedPct: scored.weekHours >= 1 ? Math.round((alignedHours / scored.weekHours) * 100) : null,
    weekHours: Math.round(scored.weekHours * 10) / 10,
    next,
    evidence: scored.evidence,
  };
}

function pickNext(three: FocusGoal[], scored: ScoredActivity): FocusState["next"] {
  const tasks = scored.tasks
    .filter((t) => t.goalId && three.some((g) => g.id === t.goalId))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  if (tasks[0]?.goalId) return { title: tasks[0].title, goalId: tasks[0].goalId, due: tasks[0].due };
  const g = three.find((x) => x.nextStep);
  return g?.nextStep ? { title: g.nextStep, goalId: g.id } : null;
}

export interface SetFocusInput {
  picks: FocusPick[];
  confirm?: boolean;
}

/** Save the user's three (keep / edit / swap / write their own). */
export async function setFocus(input: SetFocusInput, now = Date.now()): Promise<FocusState> {
  const picks = (input.picks ?? [])
    .filter((p) => p && (p.goalId || p.title?.trim()))
    .slice(0, MAX_PICKS)
    .map((p, i) => ({
      id: p.goalId?.trim() || (p.id?.startsWith("F-") ? p.id : `F-${now}-${i}`),
      goalId: p.goalId?.trim() || undefined,
      title: p.title?.trim().slice(0, 140) || undefined,
      target: p.target?.trim().slice(0, 140) || undefined,
      due: p.due?.trim().slice(0, 40) || undefined,
    }));
  if (!picks.length) throw new Error("Pick at least one goal");
  const prev = await readFocusFile();
  await writeFocusFile({
    version: 1,
    source: "user",
    pickedAt: new Date(now).toISOString(),
    confirmedAt: input.confirm === false ? (prev?.confirmedAt ?? null) : new Date(now).toISOString(),
    picks,
  });
  return getFocus(now);
}

/** Throw away the saved three and let Pen pick again from today's evidence. */
export async function repickFocus(now = Date.now()): Promise<FocusState> {
  await fs.rm(focusPath(), { force: true });
  return getFocus(now);
}

// Re-exported for tests.
export { goalKeywords, buildIdf, matchScore };
