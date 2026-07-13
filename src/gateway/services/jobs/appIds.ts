/** Sentinel app id for jobs not tied to any mini-app (shown under Ungrouped). */
export const STANDALONE_APP_ID = "__standalone__";

export function dedupeAppIds(appIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of appIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function assertCreateAppIds(appIds: string[] | undefined): string[] {
  const deduped = dedupeAppIds(appIds ?? []);
  if (deduped.length === 0) {
    throw new Error(
      "appIds is required — pass at least one mini-app UUID from list_apps. " +
        "Use appIds: ['__standalone__'] only for jobs not tied to any mini-app.",
    );
  }
  return deduped;
}

export function isStandaloneOnly(appIds: readonly string[]): boolean {
  return appIds.length === 1 && appIds[0] === STANDALONE_APP_ID;
}

export function jobBelongsToApp(
  appIds: readonly string[] | undefined,
  appId: string,
): boolean {
  return (appIds ?? []).includes(appId);
}

/** Merge app ids onto a job, dropping standalone when real apps are added. */
export function mergeJobAppIds(
  current: readonly string[] | undefined,
  additional: readonly string[],
): string[] {
  const merged = new Set<string>();
  for (const id of current ?? []) {
    if (id && id !== STANDALONE_APP_ID) merged.add(id);
  }
  for (const id of additional) {
    if (id && id !== STANDALONE_APP_ID) merged.add(id);
  }
  if (merged.size === 0) return [STANDALONE_APP_ID];
  return [...merged];
}
