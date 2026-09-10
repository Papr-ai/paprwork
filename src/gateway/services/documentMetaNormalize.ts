/**
 * Normalization for document metadata read off disk.
 *
 * `meta.json` is written by this app, by the legacy `documents.json` migration,
 * and by agents editing files directly, so what comes back is not guaranteed to
 * match `DocumentMeta`. Reading it with `JSON.parse(raw) as DocumentMeta`
 * asserts that shape rather than checking it, and the assertion is not true of
 * the files actually on disk: seeded documents carry a title and nothing else.
 *
 * The cost of that cast landed a long way from here. A document with no `id`
 * became a favourite with `id: undefined`, which the sidebar used as a React
 * list key — so the visible symptom was a key warning in `FavoritesList`, four
 * layers away from the parse that invented the missing field.
 *
 * The directory name is the authoritative id: every path helper derives from it
 * (`docDir`, `contentPath`, `metaPath`) and every lookup goes through it, so a
 * document is reachable under that name whatever `meta.json` claims. It
 * therefore wins outright rather than merely filling a gap.
 */

import type { DocumentMeta } from "./DocumentService.js";

/** A string field, or undefined when absent/blank/wrong type. */
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : value;
}

/**
 * Coerce a parsed `meta.json` into a complete `DocumentMeta`.
 *
 * Returns null only when the file holds something that is not an object at all,
 * which is corruption rather than an incomplete record — the caller rebuilds
 * from `content.md` in that case.
 */
export function normalizeDocumentMeta(
  id: string,
  parsed: unknown,
  options: { fallbackTitle: string; fallbackTimestamp?: string },
): DocumentMeta | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  const createdAt =
    readString(raw.createdAt) ??
    options.fallbackTimestamp ??
    new Date().toISOString();

  const meta: DocumentMeta = {
    // Directory name wins — see the note above.
    id,
    title: readString(raw.title) ?? options.fallbackTitle,
    // The only legal value, and absent from pre-migration files. Consumers
    // branch on it to pick an icon and a route, so a missing one is not benign.
    type: "document",
    createdAt,
    updatedAt: readString(raw.updatedAt) ?? createdAt,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    favorite: raw.favorite === true,
    preview: readString(raw.preview) ?? "",
    wordCount:
      typeof raw.wordCount === "number" && Number.isFinite(raw.wordCount)
        ? raw.wordCount
        : 0,
  };

  const createdByAgentId = readString(raw.createdByAgentId);
  if (createdByAgentId) meta.createdByAgentId = createdByAgentId;
  const createdByAgentName = readString(raw.createdByAgentName);
  if (createdByAgentName) meta.createdByAgentName = createdByAgentName;

  return meta;
}

/**
 * Whether the stored file disagrees with the record consumers will be handed,
 * and so is worth rewriting once at startup.
 *
 * Only the two load-bearing invariants count. Cosmetic gaps that normalization
 * fills with an equivalent value are left alone, so this does not rewrite every
 * document on every launch.
 */
export function documentMetaNeedsRewrite(id: string, parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const raw = parsed as Record<string, unknown>;
  return raw.id !== id || raw.type !== "document";
}
