/**
 * Pure scoring for Focus ("Your three"). No IO — focusGoals.ts gathers the evidence.
 *
 * Score = what you said (status, confidence, level, your priority order, onboarding)
 *       + where your time went (chat hours this week / month, chats touched, daily-log days)
 *       + what's pending (open tasks, something due within a week) + goal-linked apps opened.
 * Chats are matched to goals by IDF-weighted keywords from the goal title + wiki entity slugs,
 * or by the goal id itself ("G3"). Each chat counts toward its single best goal so hours are
 * never double-counted, which also makes "N% of this week on these" an honest number.
 */

export type FocusOrigin = "identity" | "onboarding" | "usecase" | "custom";

export interface FocusCandidateInput {
  id: string;
  title: string;
  origin: Exclude<FocusOrigin, "custom">;
  level?: string;
  status?: string;
  confidence?: string;
  priority?: number;
  parent?: string;
  entities?: string[];
  mentions?: number;
  nextMilestone?: string;
  detail?: string;
  /** Chat titles Sleep cited as this goal's evidence (lowercased). */
  chatRefs?: string[];
}

export interface ActivityChat {
  id: string;
  text: string;
  updatedAt: string;
  hours7: number;
  hours30: number;
}
export interface ActivityLog {
  date: string;
  text: string;
}
export interface ActivityTask {
  title: string;
  goalId?: string;
  due?: string;
}
export interface ActivityApp {
  title: string;
}

export interface FocusSignals {
  chats30: number;
  hours7: number;
  hours30: number;
  logDays: number;
  openTasks: number;
  appsOpened: number;
  nextDue?: string;
  overdue?: number;
  onboarding?: boolean;
}

export interface FocusGoal {
  id: string;
  title: string;
  origin: FocusOrigin;
  level?: string;
  status?: string;
  parent?: string;
  /** True when the user renamed Pen's goal — the title is an override, keep sending it on save. */
  edited?: boolean;
  /** Done-when, as the user phrased it (set when they edit). */
  target?: string;
  due?: string;
  /** Next milestone from IDENTITY.md. */
  nextStep?: string;
  /** One line on why Pen ranked it — evidence, not vibes. */
  why: string;
  score: number;
  signals: FocusSignals;
  entities?: string[];
}

export interface ScoredActivity {
  ranked: FocusGoal[];
  top: FocusGoal[];
  tasks: ActivityTask[];
  weekHours: number;
  evidence: string;
  hoursFor(ids: string[]): number;
}

const STOP = new Set(
  (
    "the and for with from into via per all any our your their this that these those new more most " +
    "ship build close land grow fix validate validated prevent make get run launch improve reach hit deliver " +
    "finish create set drive keep start goal goals work working plan use using shared across over under " +
    "about after before than then them they have has had will would should could can each every " +
    "chat chats help please update updates papr paprwork app apps project projects"
  ).split(" "),
);

/** Everyday words in a work-assistant corpus: they count, but only half. */
const GENERIC = new Set(
  (
    "memory search data test server quality review file token feedback loop customer revenue pipeline " +
    "stage training model models round lead day room bundle monitor dashboard report doc docs email job"
  ).split(" "),
);

function stem(w: string): string {
  return w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

/** Lowercase informative tokens; hyphenated names are kept whole and split into parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^a-z0-9$-]+/g, " ").split(" ")) {
    const w = raw.replace(/^[-$]+|-+$/g, "");
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(stem(w));
    if (w.includes("-")) {
      for (const part of w.split("-")) if (part.length >= 3 && !STOP.has(part) && !/^\d+$/.test(part)) out.push(stem(part));
    }
  }
  return out;
}

export function goalKeywords(c: Pick<FocusCandidateInput, "title" | "entities">): string[] {
  const slugs = (c.entities ?? []).map((e) => e.split("/").pop() ?? "").join(" ");
  return [...new Set(tokenize(`${c.title} ${slugs}`))];
}

/** Inverse document frequency over the chat corpus; tokens in >20% of chats are too generic to count. */
export function buildIdf(docs: Array<Set<string>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(docs.length, 1);
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, f / n > 0.2 && n >= 10 ? 0 : Math.log((n + 1) / (f + 1)) + 1);
  return idf;
}

export function matchScore(keywords: string[], doc: Set<string>, idf: Map<string, number>): { score: number; hits: number; max: number } {
  let score = 0;
  let hits = 0;
  let max = 0;
  for (const k of keywords) {
    if (!doc.has(k)) continue;
    const w = (idf.get(k) ?? 1) * (GENERIC.has(k) ? 0.5 : 1);
    if (w <= 0) continue;
    score += w;
    hits += 1;
    max = Math.max(max, w);
  }
  return { score, hits, max };
}

/** Sleep's own evidence citation: the chat title starts with a cited title (files truncate titles at ~40 chars). */
export function citedBy(refs: string[] | undefined, chatText: string): boolean {
  if (!refs?.length) return false;
  const title = chatText.split(" \n ")[0].toLowerCase().replace(/[.…\s]+$/g, "").trim();
  if (title.length < 6) return false;
  return refs.some((r) => title.startsWith(r) || r.startsWith(title));
}

const idRe = (id: string) => new RegExp(`(^|[^A-Za-z0-9])\\(?${id}\\)?(?![A-Za-z0-9])`);

/** Two informative words, or one rare one (a name like "tranche" or "h100"). */
export function matches(m: { score: number; hits: number; max: number }): boolean {
  return m.score >= 8 && (m.hits >= 2 || m.max >= 6);
}

function fmtHours(h: number): string {
  return h >= 10 ? `${Math.round(h)}h` : h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.max(1, Math.round(h * 60))}m`;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const STATUS_WEIGHT: Record<string, number> = { "on-track": 2, "at-risk": 2.4, blocked: 2, proposed: 1, unknown: 1.2 };

export function whyLine(g: Pick<FocusGoal, "origin" | "status" | "signals" | "nextStep">, priority?: number): string {
  const s = g.signals;
  const parts: string[] = [];
  if (s.onboarding) parts.push(g.origin === "identity" ? "You set it in onboarding" : "From your Papr onboarding");
  if (priority === 1 && g.origin === "identity" && g.status !== "proposed") parts.push("Your top-ranked goal");
  if (s.hours7 >= 1) parts.push(`${fmtHours(s.hours7)} in chats this week`);
  if (s.chats30 >= 2) parts.push(`${s.chats30} chats this month`);
  if (s.logDays >= 2) parts.push(`In ${s.logDays} of your last 14 daily logs`);
  if (s.overdue) parts.push(`${s.overdue} overdue task${s.overdue > 1 ? "s" : ""}`);
  else if (s.openTasks) parts.push(`${s.openTasks} open task${s.openTasks > 1 ? "s" : ""}${s.nextDue ? ` · next due ${fmtDay(s.nextDue)}` : ""}`);
  if (g.status === "at-risk") parts.push("Flagged at risk");
  if (parts.length) return parts.slice(0, 2).join(" · ");
  return g.nextStep ? `Next: ${g.nextStep}` : "From your goals";
}

export interface ScoreInput {
  goals: FocusCandidateInput[];
  onboarding: FocusCandidateInput[];
  chats: ActivityChat[];
  logs: ActivityLog[];
  tasks: ActivityTask[];
  apps: ActivityApp[];
  /** Titles + topics of many more chats (months) so IDF knows which words are everyday words. */
  corpus?: string[];
  now: number;
}

export function scoreFocusCandidates(input: ScoreInput): ScoredActivity {
  const { chats, logs, tasks, apps, now } = input;
  const chatTokens = chats.map((c) => new Set(tokenize(c.text)));
  const idf = buildIdf(input.corpus?.length ? input.corpus.map((t) => new Set(tokenize(t))) : chatTokens);

  // Onboarding goals boost the IDENTITY goal they describe; unmatched Parse goals stand alone.
  const cands = input.goals.map((g) => ({ ...g, onboarding: false }));
  for (const o of input.onboarding) {
    const ot = new Set(tokenize(`${o.title} ${o.detail ?? ""}`));
    let best: (typeof cands)[number] | undefined;
    let bestScore = 0;
    for (const c of cands) {
      if (c.origin !== "identity") continue;
      const m = matchScore(goalKeywords(c), ot, idf);
      if (m.hits >= 2 && m.score > bestScore) {
        best = c;
        bestScore = m.score;
      }
    }
    if (best) best.onboarding = true;
    else if (o.origin === "onboarding") cands.push({ ...o, onboarding: true });
  }

  const keywords = new Map(cands.map((c) => [c.id, goalKeywords(c)]));
  const sig = new Map<string, FocusSignals>(
    cands.map((c) => [c.id, { chats30: 0, hours7: 0, hours30: 0, logDays: 0, openTasks: 0, appsOpened: 0, onboarding: c.onboarding }]),
  );

  // Each chat → its single best goal.
  const chatGoal = new Map<string, string>();
  chats.forEach((chat, i) => {
    let bestId: string | undefined;
    let best = 0;
    for (const c of cands) {
      const m = matchScore(keywords.get(c.id) ?? [], chatTokens[i], idf);
      const byId =
        (c.origin === "identity" && idRe(c.id).test(chat.text) ? 5 : 0) + (citedBy(c.chatRefs, chat.text) ? 10 : 0);
      const score = m.score + byId;
      if ((byId || matches(m)) && score > best) {
        best = score;
        bestId = c.id;
      }
    }
    if (!bestId) return;
    chatGoal.set(chat.id, bestId);
    const s = sig.get(bestId)!;
    s.chats30 += 1;
    s.hours7 += chat.hours7;
    s.hours30 += chat.hours30;
  });

  for (const log of logs) {
    const lt = new Set(tokenize(log.text));
    for (const c of cands) {
      const byId = c.origin === "identity" && idRe(c.id).test(log.text);
      const m = matchScore(keywords.get(c.id) ?? [], lt, idf);
      if (byId || (m.hits >= 3 && m.score >= 8)) sig.get(c.id)!.logDays += 1;
    }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  for (const t of tasks) {
    const s = t.goalId ? sig.get(t.goalId) : undefined;
    if (!s) continue;
    s.openTasks += 1;
    if (t.due && t.due < today) s.overdue = (s.overdue ?? 0) + 1;
    else if (t.due && (!s.nextDue || t.due < s.nextDue)) s.nextDue = t.due;
  }

  for (const a of apps) {
    const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const at = new Set(tokenize(a.title));
    for (const c of cands) {
      const linked = (c.entities ?? []).some((e) => e.startsWith("app/") && e.slice(4) === slug);
      if (linked || matchScore(keywords.get(c.id) ?? [], at, idf).hits >= 2) sig.get(c.id)!.appsOpened += 1;
    }
  }

  const weekAhead = new Date(now + 7 * 86_400_000).toISOString().slice(0, 10);
  const ranked: FocusGoal[] = cands.map((c) => {
    const s = sig.get(c.id)!;
    const explicit =
      (STATUS_WEIGHT[c.status ?? "unknown"] ?? 1) +
      (c.confidence === "high" ? 0.6 : c.confidence === "medium" ? 0.3 : 0) +
      (c.level === "L2" ? 0.4 : c.level === "L3" ? 0 : 1) +
      (c.priority && c.priority < 99 ? Math.max(0, 5 - c.priority) * 0.25 : 0) +
      (s.onboarding ? 1.2 : 0);
    const activity =
      2 * Math.log1p(s.hours7) +
      0.8 * Math.log1p(s.hours30) +
      0.8 * Math.log1p(s.chats30) +
      0.6 * Math.log1p(s.logDays) +
      0.3 * Math.log1p(c.mentions ?? 0);
    const pending =
      0.5 * Math.log1p(s.openTasks) +
      (s.overdue || (s.nextDue && s.nextDue <= weekAhead) ? 0.8 : 0) +
      0.4 * Math.log1p(s.appsOpened);
    const goal: FocusGoal = {
      id: c.id,
      title: c.title,
      origin: c.origin,
      level: c.level,
      status: c.status,
      parent: c.parent,
      nextStep: c.nextMilestone,
      entities: c.entities,
      signals: { ...s, hours7: round1(s.hours7), hours30: round1(s.hours30) },
      score: Math.round((explicit + activity + pending) * 100) / 100,
      why: "",
    };
    goal.why = whyLine(goal, c.priority);
    return goal;
  });
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, undefined, { numeric: true }));

  const top: FocusGoal[] = [];
  for (const g of ranked) {
    if (top.length >= 3) break;
    // Three different things: never a goal and its own parent/child.
    if (top.some((t) => t.id === g.parent || t.parent === g.id)) continue;
    top.push(g);
  }

  const weekHours = chats.reduce((sum, c) => sum + c.hours7, 0);
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const evidence = chats.length
    ? `From ${chats.length} chats${logs.length ? " and your daily logs" : ""} since ${fmtDay(since)}`
    : "From your goals";
  return {
    ranked,
    top,
    tasks,
    weekHours,
    evidence,
    hoursFor(ids: string[]) {
      const want = new Set(ids);
      return chats.reduce((sum, c) => (want.has(chatGoal.get(c.id) ?? "") ? sum + c.hours7 : sum), 0);
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
