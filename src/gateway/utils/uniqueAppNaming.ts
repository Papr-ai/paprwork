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

/**
 * Short, URL-safe handle for the person publishing ("shawkat"), from their Papr
 * profile name or email. Used to name a linked copy's own link.
 */
export function personalSlugHandle(profile: { name?: string; email?: string } | undefined): string | undefined {
  const first = profile?.name?.trim().split(/\s+/)[0] || profile?.email?.split("@")[0] || "";
  const handle = slugifyPublishTitle(first).slice(0, 20).replace(/-+$/, "");
  return handle || undefined;
}

/**
 * A linked copy (installed from a published app) must never take the original's
 * link. "linkedin-outreach" stays the publisher's; the copy publishes as
 * "linkedin-outreach-shawkat". Returns the slug unchanged when it isn't the source's.
 */
export function linkedCopyPublishSlug(
  resolvedSlug: string,
  sourceSlug: string | undefined,
  handle: string | undefined,
): string {
  if (!sourceSlug || resolvedSlug !== sourceSlug) return resolvedSlug;
  return `${resolvedSlug}-${handle || "copy"}`;
}

/**
 * Slug variants to try when the memory server rejects a name collision. The
 * local catalog can't see teammates' published apps, so numbered guesses can all
 * be taken; the last candidate carries a random suffix so a publish never fails
 * on the name alone.
 */
export function publishSlugRetryCandidates(
  baseSlug: string,
  maxAttempts = 5,
  random: () => string = () => Math.random().toString(36).slice(2, 8),
): string[] {
  const candidates = [baseSlug];
  for (let n = 1; n < maxAttempts; n += 1) {
    candidates.push(`${baseSlug}-${n}`);
  }
  candidates.push(`${baseSlug}-${random()}`);
  return candidates;
}
