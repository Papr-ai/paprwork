/**
 * A copy on its own data (Community install, Duplicate) gets fresh database ids
 * at install: the publisher's `db-dc9c634e` becomes the copy's `db-ea27362f`.
 * Code and wiring files then differ from the publisher's only by those ids.
 *
 * Get updates must translate publisher → local ids (or the copy ends up wired
 * to the publisher's databases), and Propose must translate local → publisher
 * (or the owner's app gets re-wired to the contributor's databases).
 *
 * The pairing is by data-source alias (the sourceId the app code uses), which
 * install preserves — so it works for copies installed before this existed.
 */

interface SourceEntry {
  dbId?: string;
  alias?: string;
}

function sourcesOf(raw: string | undefined): SourceEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { sources?: SourceEntry[] } | SourceEntry[];
    return (Array.isArray(parsed) ? parsed : parsed.sources ?? []).filter(
      (s) => typeof s?.dbId === "string" && s.dbId.startsWith("db-"),
    );
  } catch {
    return [];
  }
}

/** publisher dbId → local dbId, paired by alias. Unpaired ids are left out. */
export function inferOwnDataDbIdMap(
  localDataSourcesRaw: string | undefined,
  publisherDataSourcesRaw: string | undefined,
): Map<string, string> {
  const localByAlias = new Map<string, string>();
  for (const s of sourcesOf(localDataSourcesRaw)) {
    if (s.alias) localByAlias.set(s.alias, s.dbId!);
  }
  const map = new Map<string, string>();
  for (const s of sourcesOf(publisherDataSourcesRaw)) {
    const local = s.alias ? localByAlias.get(s.alias) : undefined;
    if (local && local !== s.dbId) map.set(s.dbId!, local);
  }
  return map;
}

export function invertDbIdMap(map: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...map].map(([a, b]) => [b, a]));
}

/** Replace whole dbIds (db-xxxxxxxx) — never a prefix of a longer token. */
export function remapDbIdsInContent(content: string, map: ReadonlyMap<string, string>): string {
  if (map.size === 0) return content;
  return content.replace(/db-[0-9a-f]{8}(?![0-9a-f])/g, (id) => map.get(id) ?? id);
}

/**
 * A fork's registry folder is `{slug}-{8hex}` when the publisher's `{slug}`
 * was taken locally (uniqueForkRegistryLocalPath). Proposals must land in the
 * publisher's `{slug}` folder.
 */
export function publisherMigrationsDir(dir: string, localToPublisher: ReadonlyMap<string, string>): string {
  for (const localId of localToPublisher.keys()) {
    const suffix = `-${localId.replace(/^db-/, "")}`;
    const parts = dir.split("/");
    const i = parts.findIndex((p) => p.endsWith(suffix) && p.length > suffix.length);
    if (i >= 0) {
      parts[i] = parts[i].slice(0, -suffix.length);
      return parts.join("/");
    }
  }
  return dir;
}
