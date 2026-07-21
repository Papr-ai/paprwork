/**
 * Ensure app titles and cloud publish slugs stay unique within a workspace.
 */

import { slugifyPublishTitle } from "../services/cloudPublishDrift.js";

const TITLE_SUFFIX_PATTERN = /^(.*)_(\d+)$/;

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase();
}

/** Return a title that does not collide with existing titles (case-insensitive). */
export function ensureUniqueAppTitle(
  title: string,
  existingTitles: readonly string[],
  options?: { excludeTitle?: string },
): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return trimmed;
  }

  const excludeKey = options?.excludeTitle
    ? normalizeTitleKey(options.excludeTitle)
    : null;
  const taken = new Set<string>();
  for (const existing of existingTitles) {
    const key = normalizeTitleKey(existing);
    if (excludeKey && key === excludeKey) {
      continue;
    }
    taken.add(key);
  }

  const baseKey = normalizeTitleKey(trimmed);
  if (!taken.has(baseKey)) {
    return trimmed;
  }

  const suffixMatch = TITLE_SUFFIX_PATTERN.exec(trimmed);
  const baseName = suffixMatch?.[1]?.trim() || trimmed;

  let n = 1;
  while (taken.has(normalizeTitleKey(`${baseName}_${n}`))) {
    n += 1;
  }
  return `${baseName}_${n}`;
}

export interface PublishSlugCatalogEntry {
  appId: string;
  title: string;
  createdAt?: string;
  memorySlug?: string | null;
}

/**
 * Pick a publish slug for an app. Keeps an existing cloud slug; otherwise
 * derives from title and disambiguates local duplicates (legacy apps).
 */
export function resolveUniquePublishSlug(
  appId: string,
  catalog: readonly PublishSlugCatalogEntry[],
): string {
  const app = catalog.find((entry) => entry.appId === appId);
  if (!app) {
    return slugifyPublishTitle(appId.slice(0, 8));
  }

  if (app.memorySlug?.trim()) {
    return app.memorySlug.trim();
  }

  const base = slugifyPublishTitle(app.title);
  const colliding = catalog
    .filter((entry) => slugifyPublishTitle(entry.title) === base)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

  const rank = colliding.findIndex((entry) => entry.appId === appId);
  let candidate = rank > 0 ? `${base}-${rank}` : base;

  const reserved = new Set<string>();
  for (const entry of catalog) {
    if (entry.appId === appId) {
      continue;
    }
    const slug =
      entry.memorySlug?.trim() || slugifyPublishTitle(entry.title);
    reserved.add(slug);
  }

  let suffix = rank > 0 ? rank : 1;
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

/** Slug variants to try when the memory server rejects a name collision. */
export function publishSlugRetryCandidates(
  baseSlug: string,
  maxAttempts = 5,
): string[] {
  const candidates = [baseSlug];
  for (let n = 1; n < maxAttempts; n += 1) {
    candidates.push(`${baseSlug}-${n}`);
  }
  return candidates;
}
