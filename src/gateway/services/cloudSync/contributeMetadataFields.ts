/**
 * Field-level metadata.json for contribute-back proposals.
 *
 * metadata.json mixes per-copy details (appId, owner/org/namespace ids,
 * updatedAt, the "_2" title suffix added at install) with fields a
 * collaborator may deliberately change (title, description, icon, tags).
 * The file itself never ships in a proposal; instead we compare the
 * proposable fields to the values the copy had at install / last sync
 * (the lineage `metadataBaseline`) and write only the ones that changed onto
 * the owner's metadata.json on the proposal branch.
 */

import { createHash } from "node:crypto";

export const PROPOSABLE_METADATA_FIELDS = [
  "title",
  "description",
  "icon",
  "tags",
] as const;

export type ProposableMetadataField = (typeof PROPOSABLE_METADATA_FIELDS)[number];

export interface MetadataBaseline {
  title?: string;
  description?: string;
  icon?: string;
  tags?: string[];
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function cleanTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.map((t) => String(t).trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

/** Proposable fields of a metadata.json document, normalized. */
export function pickProposableMetadata(
  source: Record<string, unknown> | null | undefined,
): MetadataBaseline {
  if (!source) return {};
  const out: MetadataBaseline = {};
  const title = cleanString(source.title);
  const description = cleanString(source.description);
  const icon = cleanString(source.icon);
  const tags = cleanTags(source.tags);
  if (title) out.title = title;
  if (description) out.description = description;
  if (icon) out.icon = icon;
  if (tags) out.tags = tags;
  return out;
}

export function parseProposableMetadata(raw: string | undefined): MetadataBaseline | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return pickProposableMetadata(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function sameValue(
  field: ProposableMetadataField,
  a: MetadataBaseline,
  b: MetadataBaseline,
): boolean {
  if (field === "tags") {
    // Tag order is presentation only.
    const norm = (t?: string[]) => [...(t ?? [])].sort().join("\u0000");
    return norm(a.tags) === norm(b.tags);
  }
  return (a[field] ?? "") === (b[field] ?? "");
}

/**
 * Fields the collaborator deliberately changed since the baseline. A field
 * cleared locally is not proposed (owners keep their value) — clearing a
 * title/description is almost always accidental, and the file has no way to
 * say "remove" that survives the owner's own later edits.
 */
export function changedProposableMetadata(
  baseline: MetadataBaseline,
  current: MetadataBaseline,
): MetadataBaseline {
  const changed: MetadataBaseline = {};
  for (const field of PROPOSABLE_METADATA_FIELDS) {
    if (current[field] === undefined) continue;
    if (sameValue(field, baseline, current)) continue;
    (changed as Record<string, unknown>)[field] = current[field];
  }
  return changed;
}

export function hasMetadataChanges(changes: MetadataBaseline): boolean {
  return Object.keys(changes).length > 0;
}

/**
 * Owner's metadata.json with the proposed fields applied. Everything else
 * (ids, updatedAt, agentChat, …) is left exactly as the owner has it, so two
 * proposals only conflict here if both change the same field.
 */
export function applyProposableMetadata(
  ownerRaw: string,
  changes: MetadataBaseline,
): string | null {
  if (!hasMetadataChanges(changes)) return null;
  let owner: Record<string, unknown>;
  try {
    const parsed = JSON.parse(ownerRaw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    owner = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const next = { ...owner };
  let touched = false;
  for (const field of PROPOSABLE_METADATA_FIELDS) {
    const value = changes[field];
    if (value === undefined) continue;
    if (sameValue(field, pickProposableMetadata(owner), changes)) continue;
    next[field] = value;
    touched = true;
  }
  return touched ? `${JSON.stringify(next, null, 2)}\n` : null;
}

/** Stable hash of the proposable fields (for "proposed vs unproposed"). */
export function proposableMetadataHash(fields: MetadataBaseline): string {
  const ordered: Record<string, unknown> = {};
  for (const field of PROPOSABLE_METADATA_FIELDS) {
    const value = fields[field];
    if (value === undefined) continue;
    ordered[field] = field === "tags" ? [...(value as string[])].sort() : value;
  }
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Per-copy keys the collaborator's metadata.json keeps across syncs. */
const PER_COPY_KEYS = ["appId", "ownerUserId", "organizationId", "namespaceId"] as const;

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Track sync of metadata.json, field by field, instead of whole-file
 * overwrite/"conflict". Per field:
 * - publisher didn't change it (upstream == `upstreamBaseline`): keep the
 *   copy's value — preserves the install title suffix and pending edits;
 * - publisher changed it and the collaborator has an un-adopted edit: keep
 *   the edit (it is still proposable);
 * - otherwise take the publisher's value.
 * This copy's ids are always kept. Returns the file plus both baselines to
 * store: pending edits keep their old local baseline so they stay proposable.
 */
export function mergeTrackedMetadata(
  localRaw: string | undefined,
  upstreamRaw: string,
  baselines: { local: MetadataBaseline; upstream?: MetadataBaseline },
  options: { discardLocal?: boolean; copyAppId?: string } = {},
): {
  content: string;
  baseline: MetadataBaseline;
  upstreamBaseline: MetadataBaseline;
  keptLocal: ProposableMetadataField[];
} | null {
  const upstream = parseObject(upstreamRaw);
  if (!upstream) return null;
  const local = localRaw !== undefined ? parseObject(localRaw) : null;
  const result: Record<string, unknown> = { ...upstream };
  // This copy's own ids. Never take the publisher's: a missing local key stays
  // missing, or the copy reads as the publisher's app and is hidden as foreign.
  // A copy is never owned by the publisher, so an ownerUserId equal to
  // upstream's means an earlier pull leaked it: drop, don't keep. (Callers
  // remap the publisher's app id to ours in upstream text, so appId equality
  // is expected; copyAppId pins it explicitly. org / namespace legitimately
  // match for a teammate in the same workspace.)
  for (const key of PER_COPY_KEYS) {
    const leaked =
      key === "ownerUserId" &&
      local?.[key] !== undefined &&
      local[key] === upstream[key];
    if (local && local[key] !== undefined && !leaked) result[key] = local[key];
    else delete result[key];
  }
  if (options.copyAppId) result.appId = options.copyAppId;
  const localFields = pickProposableMetadata(local);
  const upstreamFields = pickProposableMetadata(upstream);
  const pending = options.discardLocal
    ? {}
    : changedProposableMetadata(baselines.local, localFields);
  const nextBaseline: MetadataBaseline = {};
  const keptLocal: ProposableMetadataField[] = [];
  const set = (target: MetadataBaseline, field: ProposableMetadataField, value: unknown) => {
    if (value !== undefined) (target as Record<string, unknown>)[field] = value;
  };
  for (const field of PROPOSABLE_METADATA_FIELDS) {
    const publisherChanged =
      !baselines.upstream || !sameValue(field, baselines.upstream, upstreamFields);
    const edited = pending[field] !== undefined;
    if (edited && !sameValue(field, localFields, upstreamFields)) {
      result[field] = localFields[field];
      keptLocal.push(field);
      set(nextBaseline, field, baselines.local[field]);
      continue;
    }
    if (!publisherChanged) {
      // Unchanged upstream: the copy's own value (e.g. "Title_2") stands;
      // discarding edits returns it to the install/last-sync value.
      const own = options.discardLocal
        ? baselines.local[field]
        : localFields[field] ?? baselines.local[field];
      if (own !== undefined) {
        result[field] = own;
        set(nextBaseline, field, edited ? own : baselines.local[field] ?? own);
        continue;
      }
    }
    set(nextBaseline, field, upstreamFields[field]);
  }
  return {
    content: `${JSON.stringify(result, null, 2)}\n`,
    baseline: nextBaseline,
    upstreamBaseline: upstreamFields,
    keptLocal,
  };
}

/** Collaborator's metadata edits vs baseline, from their metadata.json text. */
export function metadataProposalFromLocal(
  localRaw: string | undefined,
  baseline: MetadataBaseline | undefined,
): MetadataBaseline {
  if (!baseline) return {};
  const current = parseProposableMetadata(localRaw);
  if (!current) return {};
  return changedProposableMetadata(baseline, current);
}
