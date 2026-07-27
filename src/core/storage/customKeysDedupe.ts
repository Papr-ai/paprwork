import type { CustomKey } from "./CustomKeysStorage.js";

function normalizeCustomKeyName(input: string): string {
  return input.trim().toUpperCase();
}

/** Pick the newest key when multiple entries share the same name. */
export function pickNewestCustomKeyByName(
  keys: Iterable<CustomKey>,
  name: string,
): CustomKey | undefined {
  const expectedName = normalizeCustomKeyName(name);
  let newest: CustomKey | undefined;

  for (const key of keys) {
    if (normalizeCustomKeyName(key.name) !== expectedName) {
      continue;
    }
    if (!newest || key.updatedAt.localeCompare(newest.updatedAt) > 0) {
      newest = key;
    }
  }

  return newest;
}

/** Pick the newest key entry (id + key) when multiple entries share the same name. */
export function pickNewestCustomKeyEntryByName(
  entries: Iterable<[string, CustomKey]>,
  name: string,
): { id: string; key: CustomKey } | undefined {
  const expectedName = normalizeCustomKeyName(name);
  let newest: { id: string; key: CustomKey } | undefined;

  for (const [id, key] of entries) {
    if (normalizeCustomKeyName(key.name) !== expectedName) {
      continue;
    }
    if (!newest || key.updatedAt.localeCompare(newest.key.updatedAt) > 0) {
      newest = { id, key };
    }
  }

  return newest;
}

/** Remove duplicate name entries, keeping the newest updatedAt. Returns true if anything changed. */
export function dedupeCustomKeysByName(
  keys: Map<string, CustomKey>,
): boolean {
  const groups = new Map<string, Array<[string, CustomKey]>>();

  for (const [id, key] of keys) {
    const normalized = normalizeCustomKeyName(key.name);
    const group = groups.get(normalized) ?? [];
    group.push([id, key]);
    groups.set(normalized, group);
  }

  let changed = false;
  for (const [, group] of groups) {
    if (group.length <= 1) {
      continue;
    }

    group.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
    for (let index = 1; index < group.length; index += 1) {
      keys.delete(group[index][0]);
      changed = true;
    }
  }

  return changed;
}
