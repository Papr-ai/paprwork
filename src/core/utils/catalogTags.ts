/**
 * Explicit topic tags for Community / Team catalog cards.
 * Stored on mini-apps at create time (apps.json + metadata.json), published as catalogTags.
 * Integration/API key categories are shown separately in Requirements — not as tags.
 */

import { SERVICE_CATEGORIES } from "../types/bundles.js";

const SYSTEM_CATALOG_TAGS = new Set([
  "cloud",
  "team",
  "public",
  "opensource",
]);

const INTEGRATION_CATEGORY_TAGS = new Set<string>([...SERVICE_CATEGORIES]);

const TAG_ACRONYMS = new Set(["gtm", "crm", "api", "ai", "oss", "okrs"]);

/** Normalize agent/user tag input to lowercase slug tokens. */
export function normalizeCatalogTags(tags: string[] | undefined): string[] {
  if (!tags?.length) return [];
  const normalized = new Set<string>();
  for (const raw of tags) {
    const tag = raw
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (tag.length >= 2 && tag.length <= 24) {
      normalized.add(tag);
    }
  }
  return [...normalized].sort();
}

/** Topic tags only — drops internal markers and integration categories from legacy API rows. */
export function sanitizeExplicitCatalogTags(
  tags: string[] | null | undefined,
): string[] {
  return normalizeCatalogTags(tags ?? undefined).filter(
    (tag) =>
      !SYSTEM_CATALOG_TAGS.has(tag) && !INTEGRATION_CATEGORY_TAGS.has(tag),
  );
}

export function formatCatalogTagLabel(tag: string): string {
  const key = tag.trim().toLowerCase();
  if (!key || SYSTEM_CATALOG_TAGS.has(key) || INTEGRATION_CATEGORY_TAGS.has(key)) {
    return "";
  }
  return key
    .split("-")
    .filter(Boolean)
    .map((part) =>
      TAG_ACRONYMS.has(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

/** Tags ready for card chips — human labels, no integration categories. */
export function formatCatalogDisplayTags(tags: string[] | undefined): string[] {
  if (!tags?.length) return [];
  const labels = tags
    .map((tag) => formatCatalogTagLabel(tag))
    .filter((label) => label.length > 0);
  return [...new Set(labels)];
}

/** Prefer explicit manifest/registry tags; ignore legacy requirement-derived API tags. */
export function resolveCatalogEntryTags(input: {
  tags?: string[] | null;
  manifestTags?: string[] | null;
}): string[] {
  const manifest = sanitizeExplicitCatalogTags(input.manifestTags);
  if (manifest.length > 0) return manifest;
  return sanitizeExplicitCatalogTags(input.tags);
}
