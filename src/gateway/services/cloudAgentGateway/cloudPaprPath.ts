/**
 * Rewrite desktop Papr paths to the per-run PAPR_HOME clone (cloud agent gateway).
 */

import path from "path";

const PAPR_SEGMENT = `${path.sep}Papr${path.sep}`;

function stripNamespacePrefixWhenPaprHomeIsNamespace(
  rel: string,
  paprHome: string,
): string {
  const paprHomeNorm = path.normalize(paprHome);
  if (!paprHomeNorm.includes(`${path.sep}orgs${path.sep}`)) {
    return rel;
  }

  const namespaceRootMatch = paprHomeNorm.match(
    /[/\\]orgs[/\\][^/\\]+[/\\]namespaces[/\\][^/\\]+[/\\]?$/i,
  );
  if (!namespaceRootMatch) {
    return rel;
  }

  const orgNsPrefix = rel.match(/^orgs[/\\][^/\\]+[/\\]namespaces[/\\][^/\\]+[/\\]?/i)?.[0];
  if (!orgNsPrefix) {
    return rel;
  }

  return rel.slice(orgNsPrefix.length);
}

/** Map a synced dbPath (often absolute under ~/Papr) into the cloned workspace. */
export function rewritePaprPathForCloudRun(
  filePath: string,
  paprHome: string,
): string {
  const normalized = path.normalize(filePath);
  const lower = normalized.toLowerCase();
  const marker = PAPR_SEGMENT.toLowerCase();
  const idx = lower.lastIndexOf(marker);
  if (idx >= 0) {
    const rel = stripNamespacePrefixWhenPaprHomeIsNamespace(
      normalized.slice(idx + PAPR_SEGMENT.length),
      paprHome,
    );
    return path.join(path.normalize(paprHome), rel);
  }

  if (
    normalized.startsWith(`data${path.sep}`) ||
    normalized.startsWith(`Jobs${path.sep}`) ||
    normalized.startsWith(`apps${path.sep}`)
  ) {
    return path.join(paprHome, normalized);
  }

  return normalized;
}
