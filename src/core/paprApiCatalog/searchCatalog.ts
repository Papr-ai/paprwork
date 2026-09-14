import type {
  PaprApiCatalog,
  PaprApiCatalogEntry,
  PaprApiCatalogSurfaceFilter,
} from "./types.js";

export interface PaprApiSearchOptions {
  query: string;
  surface?: PaprApiCatalogSurfaceFilter;
  limit?: number;
}

export interface PaprApiSearchHit {
  score: number;
  entry: PaprApiCatalogEntry;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s/_\-.,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

function entryMatchesSurface(
  entry: PaprApiCatalogEntry,
  surface: PaprApiCatalogSurfaceFilter,
): boolean {
  if (surface === "any") {
    return true;
  }
  return entry.surfaces.includes(surface);
}

function scoreEntry(entry: PaprApiCatalogEntry, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = [
    entry.id,
    entry.title,
    entry.summary,
    entry.path ?? "",
    ...(entry.pathAliases ?? []),
    entry.toolId ?? "",
    entry.sdkRoute ?? "",
    ...entry.keywords,
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (entry.id.includes(token)) {
      score += 12;
    }
    if (entry.toolId === token) {
      score += 20;
    }
    if (entry.path?.includes(token)) {
      score += 10;
    }
    if (entry.keywords.some((k) => k === token || k.includes(token))) {
      score += 8;
    }
    if (haystack.includes(token)) {
      score += 4;
    }
  }
  return score;
}

export function searchPaprApiCatalog(
  catalog: PaprApiCatalog,
  options: PaprApiSearchOptions,
): PaprApiSearchHit[] {
  const tokens = tokenize(options.query);
  const surface = options.surface ?? "any";
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);

  const hits: PaprApiSearchHit[] = [];
  for (const entry of catalog.entries) {
    if (!entryMatchesSurface(entry, surface)) {
      continue;
    }
    const score = scoreEntry(entry, tokens);
    if (score <= 0 && tokens.length > 0) {
      continue;
    }
    hits.push({ score: tokens.length === 0 ? 1 : score, entry });
  }

  hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return hits.slice(0, limit);
}

export function formatCatalogEntryForAgent(
  entry: PaprApiCatalogEntry,
  detail: "summary" | "full",
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    surfaces: entry.surfaces,
    runtimes: entry.runtimes,
  };
  if (entry.method) {
    base.method = entry.method;
  }
  if (entry.path) {
    base.path = entry.path;
  }
  if (entry.pathAliases?.length) {
    base.pathAliases = entry.pathAliases;
  }
  if (entry.toolId) {
    base.toolId = entry.toolId;
  }
  if (entry.sdkRoute) {
    base.sdkRoute = entry.sdkRoute;
  }
  if (detail === "full") {
    if (entry.bodyFields?.length) {
      base.bodyFields = entry.bodyFields;
    }
    if (entry.limits?.length) {
      base.limits = entry.limits;
    }
    if (entry.example) {
      base.example = entry.example;
    }
    if (entry.playbookRef) {
      base.playbookRef = entry.playbookRef;
    }
  }
  return base;
}
