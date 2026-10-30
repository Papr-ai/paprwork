/**
 * Document version ids: `${YYYY-MM-DDTHH-MM-SS-sssZ}_${reason}`.
 *
 * The timestamp half contains no underscores, so the id splits on the FIRST
 * underscore. (The old parser split on every "_" and read the reason from
 * part 6, which never existed — every version showed as "Save" / "Just now".)
 */

export const AUTO_SAVE_REASON = "auto-save";

/** Auto-saves inside this window replace each other instead of piling up. */
export const AUTO_SAVE_COALESCE_MS = 10 * 60 * 1000;

export function buildVersionId(date: Date, reason: string): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${stamp}_${sanitizeVersionReason(reason)}`;
}

/** Keep labels filename-safe and short ("v2 — after review" → "v2-after-review"). */
export function sanitizeVersionReason(reason: string): string {
  const cleaned = reason
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || "save";
}

export function parseVersionId(versionId: string): {
  timestamp: string | null;
  reason: string;
} {
  const sep = versionId.indexOf("_");
  const stamp = sep === -1 ? versionId : versionId.slice(0, sep);
  const reason = sep === -1 ? "save" : versionId.slice(sep + 1) || "save";
  const iso = stamp
    .replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1-$2-$3T$4:$5:$6")
    .replace(/-(\d{3})Z$/, ".$1Z");
  const d = new Date(iso);
  return { timestamp: isNaN(d.getTime()) ? null : d.toISOString(), reason };
}

const SYSTEM_REASONS = new Set([AUTO_SAVE_REASON, "before-restore", "save"]);

/** Named versions are the ones a person or agent chose to label (e.g. "v2"). */
export function isNamedVersion(reason: string): boolean {
  return !SYSTEM_REASONS.has(reason);
}

/** Version ids come from the renderer and become file names — no traversal. */
export function isSafeVersionId(versionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(versionId) && !versionId.includes("..");
}
