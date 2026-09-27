/**
 * Sorts apps into broad categories for the Apps filter pills.
 *
 * 1. Jev picks from the current list (live + pending), batched up to 20 apps
 *    per call. Accepted at >= ACCEPT_CONFIDENCE.
 * 2. Nothing fits -> a cheap LLM proposes ONE broad category (1–2 words +
 *    definition) that must not overlap the list.
 * 3. Jev checks the proposal: same as / part of an existing one -> use that;
 *    genuinely new -> saved as "pending" (shown as "Other" until PROMOTE_AT).
 * User choices always win and are never recomputed.
 *
 * Stored locally in <papr>/data/app-categories.json (per workspace).
 */
import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import {
  ACCEPT_CONFIDENCE,
  MAX_LIVE,
  createSeedStore,
  findCategory,
  hashText,
  interpretJevPick,
  itemText,
  liveCategories,
  needsCategorizing,
  normalizeCategoryName,
  promotePending,
  visibleCategory,
  type CategorizableItem,
  type CategoryStore,
} from "../../core/utils/appCategories.js";

const NONE = "None of these";
const NEW = "Genuinely new";
const JEV_BATCH = 20;
/** Don't let pending proposals pile up past this many. */
const MAX_PENDING = 6;

interface JevChoiceAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface CategoriesSnapshot {
  categories: Array<{ name: string; definition: string; count: number }>;
  /** key -> live category name, or null for "Other". */
  byKey: Record<string, string | null>;
  version: number;
}

function storePath(): string {
  return path.join(getPaprDataDir(), "app-categories.json");
}

function load(): CategoryStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as CategoryStore;
    if (Array.isArray(parsed.categories) && parsed.assignments) return parsed;
  } catch {
    /* first run */
  }
  return createSeedStore();
}

function save(store: CategoryStore): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

function criteriaFor(store: CategoryStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of store.categories) out[c.name] = c.definition;
  return out;
}

async function jev(
  state: string,
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>,
): Promise<Record<string, JevChoiceAnswer>> {
  const { evaluateJevWithAuth } = await import("../../core/tools/jevAuth.js");
  const res = await evaluateJevWithAuth({ state, questions, timeoutMs: 30_000 });
  return res.answers as Record<string, JevChoiceAnswer>;
}

/** Step 2: ask a cheap LLM for one broad, non-overlapping category. */
async function proposeCategory(
  store: CategoryStore,
  item: CategorizableItem,
): Promise<{ name: string; definition: string } | null> {
  const { generateSimpleText } = await import("../utils/simpleTextGeneration.js");
  const list = store.categories.map((c) => `- ${c.name}: ${c.definition}`).join("\n");
  const system = [
    "You organize a library of software apps into a few BROAD categories, like departments of a company or areas of life.",
    "Propose ONE new top-level category for the app below because none of the existing ones fit.",
    "Rules: 1–2 words, Title Case, a broad area of work (e.g. 'Legal', 'Education', 'Design'), never a tool, platform, task or sub-topic (not 'LinkedIn Outreach', not 'Invoices').",
    "It must NOT overlap or be a sub-area of any existing category.",
    'Reply with JSON only: {"name": "...", "definition": "one sentence describing what belongs here"}',
  ].join("\n");
  const user = `Existing categories:\n${list}\n\n${itemText(item)}`;
  const raw = await generateSimpleText(system, user, 120, "[AppCategories]");
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      name?: string;
      definition?: string;
    };
    const name = json.name ? normalizeCategoryName(json.name) : null;
    const definition = json.definition?.trim().slice(0, 240);
    return name && definition ? { name, definition } : null;
  } catch {
    return null;
  }
}

/** Step 3: is the proposal really new, or the same as / part of an existing one? */
async function dedupeProposal(
  store: CategoryStore,
  proposal: { name: string; definition: string },
): Promise<string | null> {
  const existing = findCategory(store, proposal.name);
  if (existing) return existing.name;
  const criteria: Record<string, string> = {};
  for (const c of store.categories) criteria[c.name] = `Same as, or a sub-area of: ${c.definition}`;
  criteria[NEW] = "A different broad area of work that none of the others cover.";
  const answers = await jev(`Proposed category: ${proposal.name} — ${proposal.definition}`, {
    same: {
      type: "choice",
      instructions: "Is this proposed app category the same as (or a narrower part of) one of the existing categories, or genuinely new?",
      criteria,
    },
  });
  const a = answers.same;
  if (a?.choice && a.choice !== NEW && (a.confidence ?? 0) >= ACCEPT_CONFIDENCE) return a.choice;
  return null;
}

export class AppCategoryService {
  private queue: Promise<unknown> = Promise.resolve();

  snapshot(): CategoriesSnapshot {
    return toSnapshot(load());
  }

  /** Live category for one key (null = Other / not sorted yet). Used at publish. */
  categoryFor(key: string): string | null {
    return visibleCategory(load(), key);
  }

  /**
   * Fire-and-forget for one app right after it's created or edited, so it has
   * a category before the user next opens Apps. Skips unchanged text.
   */
  categorizeAppInBackground(app: { id: string; title: string; description?: string; tags?: string[] }): void {
    if (process.env.VITEST) return;
    void this.categorize(
      [{ key: `app:${app.id}`, title: app.title, description: app.description, tags: app.tags }],
      { allowPropose: true },
    ).catch((err) => console.warn("[AppCategories] background categorize failed:", (err as Error).message));
  }

  /** Serialized so concurrent calls never clobber the JSON file. */
  categorize(items: CategorizableItem[], opts: { allowPropose: boolean }): Promise<CategoriesSnapshot> {
    const run = this.queue.then(() => this.categorizeNow(items, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  setUserCategory(key: string, category: string | null): CategoriesSnapshot {
    const store = load();
    const cat = category ? findCategory(store, category) : undefined;
    if (category && !cat) throw new Error(`Unknown category: ${category}`);
    if (cat && cat.status !== "live") cat.status = "live";
    store.assignments[key] = {
      category: cat?.name ?? null,
      confidence: 1,
      source: "user",
      hash: "",
      listVersion: store.version,
      at: new Date().toISOString(),
    };
    save(store);
    return toSnapshot(store);
  }

  private async categorizeNow(
    items: CategorizableItem[],
    opts: { allowPropose: boolean },
  ): Promise<CategoriesSnapshot> {
    const store = load();
    const todo = items.filter((i) => needsCategorizing(store, i));
    if (todo.length === 0) return toSnapshot(store);

    const unresolved: CategorizableItem[] = [];
    for (let i = 0; i < todo.length; i += JEV_BATCH) {
      const batch = todo.slice(i, i + JEV_BATCH);
      const criteria = { ...criteriaFor(store), [NONE]: "None of the categories above is a good fit." };
      const state = batch.map((it, n) => `#${n + 1}\n${itemText(it)}`).join("\n\n");
      const questions = Object.fromEntries(
        batch.map((_, n) => [
          `app_${n + 1}`,
          {
            type: "choice" as const,
            instructions: `Which broad category best fits app #${n + 1}?`,
            criteria,
          },
        ]),
      );
      let answers: Record<string, JevChoiceAnswer>;
      try {
        answers = await jev(state, questions);
      } catch (err) {
        console.warn("[AppCategories] Jev failed:", (err as Error).message);
        break; // leave the rest for the next pass
      }
      batch.forEach((it, n) => {
        const pick = interpretJevPick(answers[`app_${n + 1}`], NONE);
        if (pick.kind === "accept") assign(store, it, pick.category, pick.confidence, "jev");
        else if (pick.kind === "propose") unresolved.push(it);
        else assign(store, it, null, 0, "jev");
      });
      save(store); // keep progress if the app quits mid-run
    }

    const canPropose = () =>
      opts.allowPropose &&
      liveCategories(store).length < MAX_LIVE &&
      store.categories.filter((c) => c.status === "pending").length < MAX_PENDING;

    for (const it of unresolved) {
      let placed: string | null = null;
      if (canPropose()) {
        try {
          const proposal = await proposeCategory(store, it);
          if (proposal) {
            placed = await dedupeProposal(store, proposal);
            if (!placed) {
              store.categories.push({
                ...proposal,
                status: "pending",
                source: "llm",
                createdAt: new Date().toISOString(),
              });
              placed = proposal.name;
            }
          }
        } catch (err) {
          console.warn("[AppCategories] propose failed:", (err as Error).message);
        }
      }
      if (placed) assign(store, it, placed, 0.5, "llm");
      else assign(store, it, null, 0, "jev");
    }

    promotePending(store);
    save(store);
    return toSnapshot(store);
  }
}

function assign(
  store: CategoryStore,
  item: CategorizableItem,
  category: string | null,
  confidence: number,
  source: "jev" | "llm",
): void {
  store.assignments[item.key] = {
    category,
    confidence,
    source,
    hash: hashText(itemText(item)),
    listVersion: store.version,
    at: new Date().toISOString(),
  };
}

function toSnapshot(store: CategoryStore): CategoriesSnapshot {
  const byKey: Record<string, string | null> = {};
  const counts = new Map<string, number>();
  for (const key of Object.keys(store.assignments)) {
    const v = visibleCategory(store, key);
    byKey[key] = v;
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return {
    categories: liveCategories(store).map((c) => ({
      name: c.name,
      definition: c.definition,
      count: counts.get(c.name) ?? 0,
    })),
    byKey,
    version: store.version,
  };
}

let instance: AppCategoryService | null = null;
export function getAppCategoryService(): AppCategoryService {
  instance ??= new AppCategoryService();
  return instance;
}
