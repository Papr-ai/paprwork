/**
 * Goal attribution — which of the user's goals does each chat and open task serve?
 *
 * Keyword overlap (focusGoalsScoring) cannot see that "built a Claude plugin / MCP UI prototype"
 * serves "Distribution via content creation": the two share no words. So attribution is a cascade,
 * cheapest signal first (FrugalGPT, Chen et al. 2023):
 *
 *   1. Explicit tag — a task Sleep tagged "(G3)" keeps it.
 *   2. Jev typed choice — one `choice` question per item over the user's goals + NONE, where each
 *      goal's criterion is its title PLUS its "counts as" scope. Jev returns calibrated
 *      probabilities; we accept only at >= ACCEPT and otherwise abstain (selective classification,
 *      Geifman & El-Yaniv 2017). An unassigned item is better than a wrong one in "Moves it".
 *   3. Keyword match — the old matcher stays the fallback when Jev is unavailable.
 *
 * Measured on this workspace (Oct 2026): with the bare goal title Jev put the Claude × Papr MCP UI
 * chat at p=0.22 Distribution; with a one-line scope it was p=1.00, while CSS-fix and training chats
 * stayed NONE / G6 at p>=0.95. The scope is what makes a goal classifiable — so every goal has one.
 *
 * Cost: Jev takes up to 20 questions per call (~300 tokens/item, ~0.5s/call). Results are cached per
 * (goal-set hash, item text hash) in workspace/goals/attribution.json, so steady state is a call
 * only for new or edited items. Runs in the background; Focus never waits on it.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";

export const ACCEPT = 0.7;
/** A Sleep tag predates user-written goals, so only a confident pick of one of those overrides it. */
export const OVERRIDE_TAG = 0.85;
export const NONE = "NONE";
const BATCH = 20;
const MAX_ITEMS = 400;

export interface AttributionGoal {
  id: string;
  title: string;
  /** "Counts as" — the kinds of work that move this goal. */
  scope?: string;
  /** User-written goal (Focus pick) rather than an IDENTITY.md goal. */
  custom?: boolean;
}

export interface AttributionItem {
  /** `chat:<id>` or `task:<id>`. */
  key: string;
  text: string;
}

export interface Attribution {
  goal: string | null;
  p: number;
  hash: string;
}

export interface AttributionFile {
  version: 1;
  goalsKey: string;
  updatedAt: string;
  items: Record<string, Attribution>;
}

interface JevChoiceAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type JevFn = (
  state: string,
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>,
) => Promise<Record<string, JevChoiceAnswer>>;

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Changes whenever a goal is added, removed, renamed or re-scoped — then every item is re-asked. */
export function goalsKey(goals: AttributionGoal[]): string {
  return sha(
    goals
      .map((g) => `${g.id}|${g.title}|${g.scope ?? ""}`)
      .sort()
      .join("\n"),
  );
}

export function criteriaFor(goals: AttributionGoal[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of goals) out[g.id] = g.scope ? `${g.title}. Counts: ${g.scope}` : g.title;
  out[NONE] = "Product maintenance, bug fixes, tooling setup, personal admin, or anything that serves none of these goals";
  return out;
}

/** Jev's answer → a goal id at >= ACCEPT, else abstain. Uses the probability table when present. */
export function pickFromAnswer(a: JevChoiceAnswer | undefined, goalIds: Set<string>): { goal: string | null; p: number } {
  if (!a) return { goal: null, p: 0 };
  let best = a.choice;
  let p = a.confidence ?? 0;
  if (a.probabilities) {
    for (const [k, v] of Object.entries(a.probabilities)) {
      if (v > (a.probabilities[best ?? ""] ?? -1)) best = k;
    }
    p = a.probabilities[best ?? ""] ?? p;
  }
  if (!best || best === NONE || !goalIds.has(best) || p < ACCEPT) return { goal: null, p: Math.round(p * 100) / 100 };
  return { goal: best, p: Math.round(p * 100) / 100 };
}

/** Items whose text changed, are new, or were classified against a different goal set. */
export function itemsNeedingWork(file: AttributionFile | null, key: string, items: AttributionItem[]): AttributionItem[] {
  if (!file || file.goalsKey !== key) return items.slice(0, MAX_ITEMS);
  return items.filter((it) => file.items[it.key]?.hash !== sha(it.text)).slice(0, MAX_ITEMS);
}

/** Classify items against goals with Jev, BATCH questions per call. Pure apart from `jev`. */
export async function classifyItems(
  goals: AttributionGoal[],
  items: AttributionItem[],
  jev: JevFn,
): Promise<Record<string, Attribution>> {
  const criteria = criteriaFor(goals);
  const ids = new Set(goals.map((g) => g.id));
  const out: Record<string, Attribution> = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const state = batch.map((it, n) => `#${n + 1} ${it.text.replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
    const questions = Object.fromEntries(
      batch.map((_, n) => [
        `item_${n + 1}`,
        {
          type: "choice" as const,
          instructions: `Which goal does item #${n + 1} move forward? Pick NONE if it is upkeep or serves no goal.`,
          criteria,
        },
      ]),
    );
    const answers = await jev(state, questions);
    batch.forEach((it, n) => {
      const pick = pickFromAnswer(answers[`item_${n + 1}`], ids);
      out[it.key] = { ...pick, hash: sha(it.text) };
    });
  }
  return out;
}

/**
 * Final goal for a task: the explicit Sleep tag wins, except when Jev confidently picks a goal the
 * user wrote (the tagger never saw those). Untagged / entity-inherited tasks take Jev's pick.
 */
export function resolveTaskGoal(
  task: { goal_id: string | null; goal_source?: string | null },
  jev: Attribution | undefined,
  goals: Map<string, AttributionGoal>,
): string | null {
  const tagged = task.goal_id && task.goal_source === "tag" && goals.has(task.goal_id) ? task.goal_id : null;
  if (!jev?.goal) return task.goal_id && goals.has(task.goal_id) ? task.goal_id : null;
  if (!tagged) return jev.goal;
  return goals.get(jev.goal)?.custom && jev.p >= OVERRIDE_TAG ? jev.goal : tagged;
}

// ---------- IO: cache + background refresh ----------

function filePath(): string {
  return path.join(getPaprWorkspaceDir(), "goals", "attribution.json");
}

export async function readAttributionFile(): Promise<AttributionFile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath(), "utf8")) as AttributionFile;
    return raw?.version === 1 && raw.items ? raw : null;
  } catch {
    return null;
  }
}

async function writeAttributionFile(file: AttributionFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath()), { recursive: true });
  const tmp = `${filePath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(file)}\n`, "utf8");
  await fs.rename(tmp, filePath());
}

/** Cached attributions valid for this exact goal set (others are stale and ignored). */
export async function readAttributions(goals: AttributionGoal[]): Promise<Map<string, Attribution>> {
  const file = await readAttributionFile();
  if (!file || file.goalsKey !== goalsKey(goals)) return new Map();
  return new Map(Object.entries(file.items));
}

const defaultJev: JevFn = async (state, questions) => {
  const { evaluateJevWithAuth } = await import("../../core/tools/jevAuth.js");
  const res = await evaluateJevWithAuth({ state, questions, timeoutMs: 30_000 });
  return res.answers as Record<string, JevChoiceAnswer>;
};

let queue: Promise<unknown> = Promise.resolve();
let lastFailureAt = 0;

/** Classify whatever changed and save. Serialized; a failure backs off 10 minutes. */
export function refreshAttributions(
  goals: AttributionGoal[],
  items: AttributionItem[],
  jev: JevFn = defaultJev,
): Promise<number> {
  const run = queue.then(async () => {
    if (Date.now() - lastFailureAt < 10 * 60_000) return 0;
    const key = goalsKey(goals);
    const prev = await readAttributionFile();
    const todo = itemsNeedingWork(prev, key, items);
    if (!todo.length) return 0;
    const base = prev && prev.goalsKey === key ? prev.items : {};
    try {
      const fresh = await classifyItems(goals, todo, jev);
      // Drop items that no longer exist so the file tracks the live window.
      const live = new Set(items.map((i) => i.key));
      const merged: Record<string, Attribution> = {};
      for (const [k, v] of Object.entries({ ...base, ...fresh })) if (live.has(k)) merged[k] = v;
      await writeAttributionFile({ version: 1, goalsKey: key, updatedAt: new Date().toISOString(), items: merged });
      return todo.length;
    } catch (err) {
      lastFailureAt = Date.now();
      console.warn("[focus] goal attribution failed:", err instanceof Error ? err.message : err);
      return 0;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Fire-and-forget from getFocus — Focus renders from the cache and picks up results next load. */
export function refreshAttributionsInBackground(goals: AttributionGoal[], items: AttributionItem[]): void {
  if (process.env.VITEST || !goals.length || !items.length) return;
  void refreshAttributions(goals, items);
}

/** Test hook. */
export function _resetAttributionBackoff(): void {
  lastFailureAt = 0;
}
