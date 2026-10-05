/**
 * Sync manifest — the merge base for deletions, like git's index.
 *
 * Per app: every repo path this computer and the web agreed on at the last
 * sync, with the blob OID both sides had. A path enters only when both sides
 * provably held the same bytes (an acked write, a pulled file, or a local file
 * whose OID matches the web's), so a file this computer never had — the
 * writer's README scaffold, files another device added and we skipped — can
 * never look "deleted".
 *
 *   in manifest · gone here  · still on web → the user deleted it here  → publish deletes it
 *   in manifest · gone on web · unchanged here → deleted elsewhere        → pull deletes it
 *   in manifest · gone on web · edited here    → conflict, user picks
 *
 * Also holds per-app delete approvals: more than MASS_DELETE_THRESHOLD deletes
 * in one go are held until the user confirms them (twice) in the sync panel.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { writeFileAtomic } from "../../../core/utils/atomicJsonWrite.js";
import { withCrossProcessFileLock } from "../../../core/utils/crossProcessFileLock.js";

export const SYNC_MANIFEST_FILENAME = "sync-manifest.json";

/** More deletes than this in one sync need an explicit (double) confirmation. */
export const MASS_DELETE_THRESHOLD = 10;

interface AppManifestEntry {
  /** repo path → blob OID both sides had at the last sync */
  files: Record<string, string>;
  /** Paths the user confirmed for removal from the web. */
  approvedDeletes?: string[];
}

interface SyncManifestFile {
  version: 1;
  apps: Record<string, AppManifestEntry>;
}

export interface AppSyncManifest {
  files: ReadonlyMap<string, string>;
  approvedDeletes: ReadonlySet<string>;
}

function manifestPath(paprHome?: string): string {
  return path.join(paprHome ?? getPaprRoot(), "data", SYNC_MANIFEST_FILENAME);
}

async function readManifestFile(filePath: string): Promise<SyncManifestFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as SyncManifestFile;
    if (parsed.version === 1 && parsed.apps && typeof parsed.apps === "object") return parsed;
  } catch {
    // missing or unreadable → empty (no deletes can be inferred from it)
  }
  return { version: 1, apps: {} };
}

/** Read-modify-write under one cross-process lock (publish worker + gateway). */
async function mutateManifest<T>(
  fn: (file: SyncManifestFile) => T | Promise<T>,
  paprHome?: string,
): Promise<T> {
  const filePath = manifestPath(paprHome);
  return withCrossProcessFileLock(filePath, async () => {
    const file = await readManifestFile(filePath);
    const before = JSON.stringify(file);
    const result = await fn(file);
    if (JSON.stringify(file) !== before) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    }
    return result;
  });
}

export async function readSyncManifest(appId: string): Promise<AppSyncManifest> {
  const entry = (await readManifestFile(manifestPath())).apps[appId.trim()];
  return {
    files: new Map(Object.entries(entry?.files ?? {})),
    approvedDeletes: new Set(entry?.approvedDeletes ?? []),
  };
}

/** Record paths both sides now agree on (add) and paths neither side has (remove). */
export async function updateSyncManifest(
  appId: string,
  change: {
    add?: ReadonlyArray<{ path: string; oid: string }>;
    remove?: readonly string[];
  },
): Promise<void> {
  const add = change.add ?? [];
  const remove = change.remove ?? [];
  if (add.length === 0 && remove.length === 0) return;
  const id = appId.trim();
  await mutateManifest((file) => {
    const entry = (file.apps[id] ??= { files: {} });
    for (const { path: p, oid } of add) entry.files[p] = oid;
    for (const p of remove) delete entry.files[p];
    if (entry.approvedDeletes && remove.length > 0) {
      const gone = new Set(remove);
      entry.approvedDeletes = entry.approvedDeletes.filter((p) => !gone.has(p));
      if (entry.approvedDeletes.length === 0) delete entry.approvedDeletes;
    }
  });
}

/**
 * The user confirmed removing these from the web. Paths not yet in the
 * manifest (files on the web this computer never synced) enter it with the
 * web's OID, so the delete carries that OID as parentHash and the writer
 * refuses it if the web copy changed in the meantime.
 */
export async function approveSyncDeletes(
  appId: string,
  entries: ReadonlyArray<{ path: string; oid: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  const id = appId.trim();
  await mutateManifest((file) => {
    const entry = (file.apps[id] ??= { files: {} });
    const approved = new Set(entry.approvedDeletes ?? []);
    for (const { path: p, oid } of entries) {
      entry.files[p] ??= oid;
      approved.add(p);
    }
    entry.approvedDeletes = [...approved].sort();
  });
}

export async function removeAppFromSyncManifest(
  appId: string,
  paprHome?: string,
): Promise<boolean> {
  const id = appId.trim();
  return mutateManifest((file) => {
    if (!file.apps[id]) return false;
    delete file.apps[id];
    return true;
  }, paprHome);
}
