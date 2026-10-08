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
  readAttributions,
  refreshAttributionsInBackground,
  resolveTaskGoal,
  type AttributionGoal,
  type AttributionItem,
} from "./focusAttribution.js";
import {
  scoreFocusCandidates,
  goalKeywords,
  tokenize,
  buildIdf,
  matchScore,
  type ActivityChat,
  type ActivityTurn,
  type ActivityApp,
  type ActivityLog,
  type ActivityTask,
  type FocusCandidateInput,
  type FocusGoal,
  type FocusRepeat,
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
  repeat?: FocusRepeat;
  /** "Counts as" — what work moves this goal. Drafted by Pen for goals you write, editable by you. */
  scope?: string;
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

/** Local Monday 00:00 of the week containing `now` (ms). Weekly hours reset here, not on a rolling 7 days. */
export function startOfWeek(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

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
    const since7 = new Date(startOfWeek(now)).toISOString();
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
    const turnRows = db
      .prepare(
        `SELECT m.chat_id AS chatId, m.role, CASE WHEN m.role = 'user' THEN substr(m.content, 1, 1500) END AS text,
                COALESCE(m.turn_duration_ms, 0) AS ms
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.timestamp >= @since7 AND c.id NOT LIKE 'job:%' AND c.id NOT LIKE 'delegation:%'
          ORDER BY m.chat_id, m.timestamp`,
      )
      .all({ since7 }) as Array<{ chatId: string; role: string; text: string | null; ms: number }>;
    const turns = new Map<string, ActivityTurn[]>();
    for (const r of turnRows) {
      const list = turns.get(r.chatId) ?? [];
      if (r.role === "user" || !list.length) list.push({ text: r.text ?? "", hours7: 0 });
      if (r.role === "assistant") list[list.length - 1].hours7 += r.ms / 3_600_000;
      turns.set(r.chatId, list);
    }
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
      turns: turns.get(r.id),
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

interface OpenTask {
  id: string;
  title: string;
  due: string | null;
  goal_id: string | null;
  goal_source?: string | null;
  entity_ref: string | null;
}

async function readOpenTasks(): Promise<OpenTask[]> {
  try {
    const { readWorkspaceTasks } = await import("./workspaceTasks.js");
    return (await readWorkspaceTasks({ status: "open" })).tasks as OpenTask[];
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

/** Score id for a user-written pick, so it never collides with the IDENTITY goal it was saved on. */
export const customId = (pickId: string) => `pick:${pickId}`;

/** What an IDENTITY goal covers, from its own fields (no LLM): next milestone + the entities it runs through. */
export function identityScope(g: Pick<WorkspaceGoal, "nextMilestone" | "entities">): string | undefined {
  const names = (g.entities ?? []).map((e) => (e.split("/").pop() ?? "").replace(/-/g, " ")).filter(Boolean);
  const parts = [g.nextMilestone, names.length ? names.slice(0, 6).join(", ") : ""].filter(Boolean);
  return parts.length ? parts.join("; ").slice(0, 300) : undefined;
}

/** Picks that are the user's own goal (written from scratch, or rewritten into a different goal). */
function customPicks(picks: FocusPick[], byGoal: Map<string, WorkspaceGoal>): FocusPick[] {
  return picks.filter((p) => {
    if (!p.title) return false;
    if (!p.goalId) return true;
    const g = byGoal.get(p.goalId);
    return Boolean(g && !isSameGoal(p.title, g.title));
  });
}

export interface RankedFocus extends ScoredActivity {
  /** Score goal id → open task ids that move it. */
  taskIdsByGoal: Map<string, string[]>;
}

/** Rank every candidate (plus the user's own written goals in `picks`) against today's evidence. */
export async function rankFocusCandidates(now = Date.now(), picks: FocusPick[] = []): Promise<RankedFocus> {
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
  const byGoal = new Map(goalsRes.goals.map((g) => [g.id, g]));
  const mine = customPicks(picks, byGoal);
  const customs: FocusCandidateInput[] = mine.map((p) => ({
    id: customId(p.id),
    title: p.title!,
    origin: "custom",
    extraKeywords: [p.target, p.scope].filter(Boolean).join(" "),
  }));
  const goals = [...active.map(toInput), ...customs];

  // Which goal each chat / task serves: explicit tag > Jev (cached) > keywords. See focusAttribution.ts.
  const pickScope = new Map(picks.filter((p) => p.goalId && p.scope && !mine.includes(p)).map((p) => [p.goalId!, p.scope!]));
  const attrGoals: AttributionGoal[] = [
    ...active.map((g) => ({ id: g.id, title: g.title, scope: pickScope.get(g.id) ?? identityScope(g) })),
    ...mine.map((p) => ({ id: customId(p.id), title: p.title!, scope: p.scope ?? p.target, custom: true })),
  ];
  const goalMap = new Map(attrGoals.map((g) => [g.id, g]));
  const cache = await readAttributions(attrGoals).catch(() => new Map());
  const activityTasks: ActivityTask[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    due: t.due ?? undefined,
    goalId: resolveTaskGoal(t, cache.get(`task:${t.id}`), goalMap) ?? undefined,
  }));
  const chatGoals = new Map<string, string | null>();
  for (const c of chats) {
    const a = cache.get(`chat:${c.id}`);
    if (a) chatGoals.set(c.id, a.goal);
  }
  const items: AttributionItem[] = [
    ...chats.map((c) => ({ key: `chat:${c.id}`, text: c.text.slice(0, 600) })),
    ...tasks.map((t) => ({ key: `task:${t.id}`, text: `${t.title}${t.entity_ref ? ` (${t.entity_ref})` : ""}` })),
  ];
  refreshAttributionsInBackground(attrGoals, items);

  const scored = scoreFocusCandidates({ goals, onboarding, chats, corpus, logs, tasks: activityTasks, apps, chatGoals, now });
  const taskIdsByGoal = new Map<string, string[]>();
  for (const t of activityTasks) {
    if (!t.goalId || !t.id) continue;
    taskIdsByGoal.set(t.goalId, [...(taskIdsByGoal.get(t.goalId) ?? []), t.id]);
  }
  return Object.assign(scored, { taskIdsByGoal });
}

/**
 * A pick rewritten into a different goal ("Validate MHAR…" → "Distribution via content…") becomes the
 * user's own goal with its own id. Keeping `goalId: "G4"` made every surface that matches by id
 * (task chips, "Moves it") show G4's MHAR tasks under Distribution.
 */
export function splitDivergedPicks(picks: FocusPick[], goals: Map<string, Pick<WorkspaceGoal, "title">>, now: number): { picks: FocusPick[]; changed: boolean } {
  let changed = false;
  const out = picks.map((p, i) => {
    const g = p.goalId ? goals.get(p.goalId) : undefined;
    if (!g || !p.title || isSameGoal(p.title, g.title)) return p;
    changed = true;
    const { goalId: _drop, ...rest } = p;
    return { ...rest, id: p.id.startsWith("F-") ? p.id : `F-${now}-${i}` };
  });
  return { picks: out, changed };
}

export function isSameGoal(edited: string, original: string): boolean {
  const a = new Set(tokenize(original));
  return tokenize(edited).some((t) => a.has(t));
}

function applyPick(pick: FocusPick, byId: Map<string, FocusGoal>): FocusGoal | null {
  let base = pick.goalId ? byId.get(pick.goalId) : undefined;
  if (pick.goalId && !base) return null; // goal closed or removed → slot needs a refill
  // A rewrite that shares no words with the goal it was saved on is a different goal. Don't inherit
  // that goal's tasks, hours or milestone (G4 "Validate MHAR…" renamed "Distribution via content…").
  if (base && pick.title && !isSameGoal(pick.title, base.title)) base = undefined;
  if (!base) {
    if (!pick.title) return null;
    const own = byId.get(customId(pick.id));
    return {
      id: pick.id,
      title: pick.title,
      target: pick.target,
      due: pick.due,
      repeat: pick.repeat,
      scope: pick.scope,
      origin: "custom",
      why: own && own.why !== "From your goals" ? own.why : "Written by you",
      score: own?.score ?? 0,
      signals: own?.signals ?? { chats30: 0, hours7: 0, hours30: 0, logDays: 0, openTasks: 0, appsOpened: 0 },
    };
  }
  return {
    ...base,
    id: pick.id,
    title: pick.title || base.title,
    edited: Boolean(pick.title && pick.title !== base.title) || undefined,
    target: pick.target ?? base.target,
    // A repeating goal has no finish date, so it never inherits one.
    due: pick.repeat ? undefined : (pick.due ?? base.due),
    repeat: pick.repeat,
    scope: pick.scope,
  };
}

/** Resolve the saved three against today's evidence; first run quietly saves Pen's picks. */
export async function getFocus(now = Date.now()): Promise<FocusState> {
  let file = await readFocusFile();
  let migrated = false;
  if (file?.picks.some((p) => p.goalId && p.title)) {
    const goals = new Map((await readWorkspaceGoals()).goals.map((g) => [g.id, g]));
    const split = splitDivergedPicks(file.picks, goals, now);
    if (split.changed) {
      file = { ...file, picks: split.picks };
      migrated = true;
    }
  }
  const scored = await rankFocusCandidates(now, file?.picks);
  const byId = new Map(scored.ranked.map((g) => [g.id, g]));
  let dirty = migrated;
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
    if (g.origin === "custom") continue;
    if (three.some((t) => t.id === g.id || t.id === g.parent || t.parent === g.id)) continue;
    three.push(g);
    keptPicks.push({ id: g.id, goalId: g.id });
    dirty = true;
  }
  if (dirty && keptPicks.length) {
    file = { ...file, picks: keptPicks };
    await writeFocusFile(file).catch((err) => console.warn("[focus] could not save picks:", err));
  }
  const scoreIdOf = (g: FocusGoal) => (g.origin === "custom" ? customId(g.id) : g.id);
  for (const g of three) g.taskIds = scored.taskIdsByGoal.get(scoreIdOf(g)) ?? [];
  for (const g of three) if (g.origin === "custom") g.signals = { ...g.signals, openTasks: g.taskIds?.length ?? 0 };
  await attachTrackers(three);
  draftMissingScopes(file.picks);
  const chosen = new Set(three.map((g) => g.id));
  const candidates = scored.ranked.filter((g) => g.origin !== "custom" && !chosen.has(g.id)).slice(0, 6);
  const alignedHours = scored.hoursFor(three.map((g) => (g.origin === "custom" ? customId(g.id) : g.id)));
  const next = pickNext(three, scored, scoreIdOf);
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

function pickNext(three: FocusGoal[], scored: ScoredActivity, scoreIdOf: (g: FocusGoal) => string): FocusState["next"] {
  const slotOf = new Map(three.map((g) => [scoreIdOf(g), g.id]));
  const tasks = scored.tasks
    .filter((t) => t.goalId && slotOf.has(t.goalId))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  if (tasks[0]?.goalId) return { title: tasks[0].title, goalId: slotOf.get(tasks[0].goalId)!, due: tasks[0].due };
  const g = three.find((x) => x.nextStep);
  return g?.nextStep ? { title: g.nextStep, goalId: g.id } : null;
}

/** Clean one pick from the editor: trim, cap lengths, and drop the due date on repeating goals. */
export function normalizePick(p: FocusPick, i: number, now: number): FocusPick {
  const repeat = p.repeat === "daily" || p.repeat === "weekly" ? p.repeat : undefined;
  return {
    id: p.goalId?.trim() || (p.id?.startsWith("F-") ? p.id : `F-${now}-${i}`),
    goalId: p.goalId?.trim() || undefined,
    title: p.title?.trim().slice(0, 140) || undefined,
    target: p.target?.trim().slice(0, 140) || undefined,
    due: repeat ? undefined : p.due?.trim().slice(0, 40) || undefined,
    repeat,
    scope: p.scope?.trim().slice(0, 300) || undefined,
  };
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
    .map((p, i) => normalizePick(p, i, now));
  if (!picks.length) throw new Error("Pick at least one goal");
  const prev = await readFocusFile();
  // Keep a scope the user didn't touch in this edit (the editor may not send it).
  for (const p of picks) if (p.scope === undefined) p.scope = prev?.picks.find((x) => x.id === p.id)?.scope;
  const goals = new Map((await readWorkspaceGoals()).goals.map((g) => [g.id, g]));
  const split = splitDivergedPicks(picks, goals, now);
  picks.splice(0, picks.length, ...split.picks);
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

// ---------- trackers + scope drafting ----------

async function attachTrackers(three: FocusGoal[]): Promise<void> {
  try {
    const { trackerStates } = await import("./focusTrackers.js");
    const states = await trackerStates(three.map((g) => ({ id: g.id, title: g.title, target: g.target, scope: g.scope })));
    for (const g of three) g.tracker = states[g.id];
  } catch (err) {
    console.warn("[focus] tracker state unavailable:", err instanceof Error ? err.message : err);
  }
}

let drafting: Promise<unknown> | null = null;

/**
 * A goal the user wrote has no scope yet: Pen drafts one line of "counts as" from the goal and the
 * user's recent chat titles, saves it on the pick (user can edit it), and attribution re-runs.
 */
function draftMissingScopes(picks: FocusPick[]): void {
  const todo = picks.filter((p) => p.title && !p.goalId && !p.scope);
  if (!todo.length || drafting || process.env.VITEST) return;
  drafting = (async () => {
    const { generateSimpleText } = await import("../utils/simpleTextGeneration.js");
    const { chats } = await readChats(Date.now()).catch(() => ({ chats: [] as ActivityChat[] }));
    const recent = chats
      .sort((a, b) => b.hours30 - a.hours30)
      .slice(0, 25)
      .map((c) => `- ${c.text.split(" \n ")[0].slice(0, 80)}`)
      .join("\n");
    const drafts = new Map<string, string>();
    for (const p of todo) {
      const text = await generateSimpleText(
        [
          "You define what work counts toward a person's goal, so a classifier can sort their chats and tasks under it.",
          "Reply with ONE line, at most 45 words: the kinds of work that move this goal — channels, artifacts, campaigns, and indirect work like tools, integrations or launches built to serve it.",
          "Name items from their recent work only when they clearly serve this goal. Concrete nouns, no preamble, no quotes.",
        ].join("\n"),
        `Goal: ${p.title}${p.target ? `\nDone when: ${p.target}` : ""}\n\nTheir recent work:\n${recent}`,
        120,
        "[FocusScope]",
      );
      const line = text?.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^["']|["']$/g, "").slice(0, 300);
      if (line) drafts.set(p.id, line);
    }
    if (!drafts.size) return;
    const file = await readFocusFile();
    if (!file) return;
    let changed = false;
    for (const p of file.picks) {
      const d = drafts.get(p.id);
      if (d && !p.scope) {
        p.scope = d;
        changed = true;
      }
    }
    if (changed) await writeFocusFile(file);
  })()
    .catch((err) => console.warn("[focus] scope draft failed:", err instanceof Error ? err.message : err))
    .finally(() => {
      drafting = null;
    });
}
