/**
 * Registry of Turso databases that attach to a publisher's primary segment
 * (team collaborate / track + databasePolicy: shared).
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import path from "path";

export const SHARED_PRIMARY_TURSO_FILENAME = ".shared-primary-turso.json";

export interface SharedPrimaryTursoEntry {
  namespaceId: string;
  slug: string;
  publisherUserId: string;
  localAppId: string;
  shareToken?: string;
}

export interface SharedPrimaryTursoStoreFile {
  databases: Record<string, SharedPrimaryTursoEntry>;
}

function defaultStore(): SharedPrimaryTursoStoreFile {
  return { databases: {} };
}

export function resolveSharedPrimaryTursoStorePath(paprDir?: string): string {
  const root = paprDir ?? getPaprRoot();
  return path.join(root, "data", SHARED_PRIMARY_TURSO_FILENAME);
}

export function loadSharedPrimaryTursoStore(
  paprDir?: string,
): SharedPrimaryTursoStoreFile {
  const storePath = resolveSharedPrimaryTursoStorePath(paprDir);
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as SharedPrimaryTursoStoreFile;
    if (parsed?.databases && typeof parsed.databases === "object") {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return defaultStore();
}

export function saveSharedPrimaryTursoStore(
  store: SharedPrimaryTursoStoreFile,
  paprDir?: string,
): void {
  const storePath = resolveSharedPrimaryTursoStorePath(paprDir);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function lookupSharedPrimaryTursoEntry(
  tursoShortName: string,
  paprDir?: string,
): SharedPrimaryTursoEntry | null {
  const store = loadSharedPrimaryTursoStore(paprDir);
  return store.databases[tursoShortName] ?? null;
}

export function registerSharedPrimaryTursoEntries(
  entries: ReadonlyArray<
    SharedPrimaryTursoEntry & { tursoShortName: string }
  >,
  paprDir?: string,
): void {
  if (entries.length === 0) {
    return;
  }
  const store = loadSharedPrimaryTursoStore(paprDir);
  for (const entry of entries) {
    store.databases[entry.tursoShortName] = {
      namespaceId: entry.namespaceId,
      slug: entry.slug,
      publisherUserId: entry.publisherUserId,
      localAppId: entry.localAppId,
      ...(entry.shareToken ? { shareToken: entry.shareToken } : {}),
    };
  }
  saveSharedPrimaryTursoStore(store, paprDir);
}

export function removeSharedPrimaryTursoEntriesForApp(
  localAppId: string,
  paprDir?: string,
): void {
  const store = loadSharedPrimaryTursoStore(paprDir);
  let changed = false;
  for (const [tursoName, entry] of Object.entries(store.databases)) {
    if (entry.localAppId === localAppId) {
      delete store.databases[tursoName];
      changed = true;
    }
  }
  if (changed) {
    saveSharedPrimaryTursoStore(store, paprDir);
  }
}
