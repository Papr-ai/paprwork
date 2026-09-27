/**
 * App categories: a short list of broad, mutually exclusive areas of work
 * used for the filter pills on Library / Team / Community.
 *
 * Pure data + rules only (no I/O). The gateway AppCategoryService does the
 * Jev / LLM calls and persistence.
 *
 * Rules:
 * - Categories are high level ("Sales", "Finance"), never sub-topics
 *   ("LinkedIn outreach", "Invoices").
 * - Each has a one-line definition; Jev decides using the definitions, so
 *   they are what keep categories from overlapping.
 * - New categories proposed by the LLM start "pending" and only become
 *   filter pills once PROMOTE_AT items are in them.
 * - At most MAX_LIVE live categories; past that nothing new is proposed.
 */

export type CategoryStatus = "live" | "pending";
export type CategorySource = "seed" | "llm";
export type AssignmentSource = "jev" | "llm" | "user";

export interface CategoryDef {
  name: string;
  definition: string;
  status: CategoryStatus;
  source: CategorySource;
  createdAt: string;
}

export interface CategoryAssignment {
  /** null = no confident fit ("Other"). */
  category: string | null;
  confidence: number;
  source: AssignmentSource;
  /** Hash of the text that was categorized; re-run when it changes. */
  hash: string;
  /** Category-list version at the time; "Other" items re-run when it changes. */
  listVersion: number;
  at: string;
}

export interface CategoryStore {
  version: number;
  categories: CategoryDef[];
  assignments: Record<string, CategoryAssignment>;
}

export interface CategorizableItem {
  /** "app:<id>" for library apps, "catalog:<catalogId>" for team/community. */
  key: string;
  title: string;
  description?: string;
  tags?: string[];
}

/** Jev confidence needed to accept a pick from the existing list. */
export const ACCEPT_CONFIDENCE = 0.6;
/** Items needed before a pending category becomes a filter pill. */
export const PROMOTE_AT = 3;
/** Hard cap on live categories. */
export const MAX_LIVE = 12;

export const SEED_CATEGORIES: ReadonlyArray<Pick<CategoryDef, "name" | "definition">> = [
  { name: "Sales", definition: "Finding, contacting and tracking prospects, leads, deals and customers' buying journey." },
  { name: "Marketing", definition: "Content, campaigns, social media, SEO, brand and audience growth." },
  { name: "Support", definition: "Helping existing customers: tickets, inboxes, help docs and customer feedback." },
  { name: "Research", definition: "Gathering and summarizing information: news, papers, competitors, markets, people." },
  { name: "Operations", definition: "Running the business day to day: tasks, scheduling, hiring, internal processes and admin." },
  { name: "Finance", definition: "Money: expenses, invoices, revenue, budgets, payments, accounting and investing." },
  { name: "Engineering", definition: "Building and running software: code, repos, deployments, monitoring and developer tools." },
  { name: "Analytics", definition: "Dashboards, metrics and reports that track performance over time." },
  { name: "Personal", definition: "Personal life and productivity: health, habits, travel, learning, hobbies, home." },
];

export function createSeedStore(now = new Date().toISOString()): CategoryStore {
  return {
    version: 1,
    categories: SEED_CATEGORIES.map((c) => ({ ...c, status: "live", source: "seed", createdAt: now })),
    assignments: {},
  };
}

export function liveCategories(store: CategoryStore): CategoryDef[] {
  return store.categories.filter((c) => c.status === "live");
}

/** Text Jev / the LLM sees for one item (kept short). */
export function itemText(item: CategorizableItem): string {
  const parts = [`App: ${item.title.trim()}`];
  if (item.description?.trim()) parts.push(item.description.trim().slice(0, 600));
  if (item.tags?.length) parts.push(`Tags: ${item.tags.slice(0, 8).join(", ")}`);
  return parts.join("\n");
}

/** Small stable hash (FNV-1a) — only used to detect changed text. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** True when this item has to be (re)categorized. User choices never re-run. */
export function needsCategorizing(store: CategoryStore, item: CategorizableItem): boolean {
  const a = store.assignments[item.key];
  if (!a) return true;
  if (a.source === "user") return false;
  if (a.hash !== hashText(itemText(item))) return true;
  return a.category === null && a.listVersion !== store.version;
}

/** Normalize an LLM-proposed name: 1–2 words, Title Case, no punctuation. */
export function normalizeCategoryName(raw: string): string | null {
  const cleaned = raw.replace(/[^\p{L}\p{N}&\s-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const all = cleaned.split(" ");
  // Allow "Legal & Compliance" / "Health and Fitness", otherwise max 2 words.
  const joiner = all[1] === "&" || all[1]?.toLowerCase() === "and";
  const words = all.slice(0, joiner ? 3 : 2).filter((w) => w !== "&" || joiner);
  if (joiner && words.length < 3) words.splice(1);
  const name = words
    .map((w) => (w.toLowerCase() === "and" ? "&" : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  return name.length >= 2 && name.length <= 28 ? name : null;
}

export function findCategory(store: CategoryStore, name: string): CategoryDef | undefined {
  const n = name.trim().toLowerCase();
  return store.categories.find((c) => c.name.toLowerCase() === n);
}

/**
 * Promote pending categories that reached PROMOTE_AT items (within the cap).
 * Bumps the list version so "Other" items get another pass. Returns promoted names.
 */
export function promotePending(store: CategoryStore): string[] {
  const counts = new Map<string, number>();
  for (const a of Object.values(store.assignments)) {
    if (a.category) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  }
  const promoted: string[] = [];
  for (const c of store.categories) {
    if (c.status !== "pending") continue;
    if (liveCategories(store).length >= MAX_LIVE) break;
    if ((counts.get(c.name) ?? 0) >= PROMOTE_AT) {
      c.status = "live";
      promoted.push(c.name);
    }
  }
  if (promoted.length) store.version += 1;
  return promoted;
}

/** What the UI shows: pending categories read as "Other" (null). */
export function visibleCategory(store: CategoryStore, key: string): string | null {
  const a = store.assignments[key];
  if (!a?.category) return null;
  return findCategory(store, a.category)?.status === "live" ? a.category : null;
}
