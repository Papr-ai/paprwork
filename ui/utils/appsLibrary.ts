/**
 * Pure helpers for the Apps library: sidebar sections, card status lines and
 * near-duplicate grouping. Kept free of React so they are unit-testable.
 */
import type { Artifact } from "../stores/artifactsStore";
import type { AppHealth } from "../../src/core/utils/appsHealth";

export type LibrarySection =
  | "recent"
  | "favorites"
  | "live"
  | "drafts"
  | "automations"
  | "attention"
  | "archived";

export type DiscoverSection = "team" | "community";
export type AppsSection = LibrarySection | DiscoverSection;

export const LIBRARY_SECTIONS: readonly LibrarySection[] = [
  "recent",
  "favorites",
  "live",
  "drafts",
  "automations",
  "attention",
  "archived",
];

export function isLibrarySection(s: AppsSection): s is LibrarySection {
  return (LIBRARY_SECTIONS as readonly string[]).includes(s);
}

const statusOf = (a: Artifact) => a.status ?? "active";
const isArchived = (a: Artifact) => statusOf(a) === "archived";

/** Titles like "a3f9c1e2-77b0-…" come from recovered/corrupted index entries. */
export function isIdLikeTitle(title: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(title.trim());
}

export function needsAttention(
  a: Artifact,
  health: AppHealth | undefined,
): boolean {
  if (isArchived(a)) return false;
  return health?.state === "failed" || isIdLikeTitle(a.title);
}

export interface SectionContext {
  publishedIds: ReadonlySet<string>;
  health: Readonly<Record<string, AppHealth>>;
}

export function inSection(
  a: Artifact,
  section: LibrarySection,
  ctx: SectionContext,
): boolean {
  switch (section) {
    case "recent":
      return !isArchived(a);
    case "favorites":
      return Boolean(a.favorite) && !isArchived(a);
    case "live":
      return ctx.publishedIds.has(a.id) && !isArchived(a);
    case "drafts":
      return statusOf(a) === "draft" && !ctx.publishedIds.has(a.id);
    case "automations":
      return !isArchived(a) && (ctx.health[a.id]?.scheduledJobCount ?? 0) > 0;
    case "attention":
      return needsAttention(a, ctx.health[a.id]);
    case "archived":
      return isArchived(a);
  }
}

export function sectionCounts(
  apps: readonly Artifact[],
  ctx: SectionContext,
): Record<LibrarySection, number> {
  const counts = Object.fromEntries(
    LIBRARY_SECTIONS.map((s) => [s, 0]),
  ) as Record<LibrarySection, number>;
  for (const a of apps) {
    for (const s of LIBRARY_SECTIONS) if (inSection(a, s, ctx)) counts[s] += 1;
  }
  return counts;
}

/**
 * Normalised title used to spot copies: "Reddit Research Agent_2",
 * "Reddit Research Agent (copy)" and "reddit research agent 3" all collapse
 * to "reddit research agent". Id-like titles never group.
 */
export function duplicateKey(title: string): string | null {
  if (isIdLikeTitle(title)) return null;
  const base = title
    .trim()
    .toLowerCase()
    .replace(/\s*\((?:copy|copy \d+|\d+)\)$/, "")
    .replace(/[\s_-]+(?:copy|v?\d{1,3})$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return base || null;
}

/** Groups of 2+ non-archived apps sharing a duplicate key, most recent first. */
export function findDuplicateGroups(
  apps: readonly Artifact[],
  lastActivity: (a: Artifact) => number,
): Artifact[][] {
  const groups = new Map<string, Artifact[]>();
  for (const a of apps) {
    if (isArchived(a)) continue;
    const key = duplicateKey(a.title);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((x, y) => lastActivity(y) - lastActivity(x)));
}
