/**
 * Deletions in both directions, decided against the sync manifest (the last
 * state this computer and the web agreed on — see SyncManifest.ts). Both sides
 * of every comparison come from the same walk publish uses, so .gitignore,
 * never-track, dotfile and size rules apply to deletes with no extra rules.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { parseMonolithicJobJson } from "../jobs/jobRuntimeFields.js";
import { computeBlobOidForContent } from "./computeParentHash.js";
import { MASS_DELETE_THRESHOLD, type AppSyncManifest } from "./SyncManifest.js";

/** Files the writer puts in a new repo. Never the user's; never offered for removal. */
const WRITER_SCAFFOLD = new Set(["README.md", ".gitignore"]);

/** Where a repo path lives on this computer. */
export function localPathForRepoPath(paprDir: string, appId: string, repoPath: string): string {
  const parts = repoPath.split("/");
  if (parts[0] === "jobs" && parts.length > 2) {
    return path.join(paprDir, "Jobs", ...parts.slice(1));
  }
  if (parts[0] === "databases" && parts.length > 2) {
    return path.join(paprDir, "data", "databases", ...parts.slice(1));
  }
  return path.join(paprDir, "apps", appId, ...parts);
}

export async function readJobConfigJson(fullPath: string): Promise<string> {
  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { config } = parseMonolithicJobJson(parsed);
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** File content exactly as publish would send it; null when the file is gone. */
export async function readLocalRepoContent(
  paprDir: string,
  appId: string,
  repoPath: string,
): Promise<string | null> {
  const full = localPathForRepoPath(paprDir, appId, repoPath);
  try {
    if (repoPath.startsWith("jobs/") && path.basename(repoPath) === "job.json") {
      return await readJobConfigJson(full);
    }
    return await fs.readFile(full, "utf8");
  } catch {
    return null;
  }
}

async function isGone(paprDir: string, appId: string, repoPath: string): Promise<boolean> {
  return fs.lstat(localPathForRepoPath(paprDir, appId, repoPath)).then(
    () => false,
    () => true,
  );
}

/**
 * Folders the walk actually read: "app" (the app folder, when it exists and
 * has files), "jobs/{id}/" per linked job folder present, and
 * "databases/{slug}/migrations/" per readable schema folder. A path outside
 * every scanned folder is unknown, never "deleted" — an unlinked job, a
 * missing or unmaterialised app folder cannot wipe the web copy.
 */
export function isUnderScannedRoot(repoPath: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (root === "app") {
      const top = repoPath.split("/")[0];
      if (top !== "jobs" && top !== "databases") return true;
    } else if (repoPath.startsWith(root)) {
      return true;
    }
  }
  return false;
}

export interface LocalDeletePlan {
  /** Send now: delete op with the manifest OID as parentHash. */
  deletes: Array<{ path: string; parentHash: string }>;
  /** Over the threshold and not confirmed yet. */
  held: string[];
  /** On the web, not here, never synced from here. Only "Remove from web" deletes these. */
  webOnly: string[];
  /** In the manifest but already gone on the web — just forget them. */
  alreadyGone: string[];
}

/** Publish side: what this computer deleted since the last sync. */
export async function planLocalDeletes(input: {
  paprDir: string;
  appId: string;
  present: ReadonlySet<string>;
  roots: ReadonlySet<string>;
  cachedOids: Readonly<Record<string, string>>;
  manifest: AppSyncManifest;
}): Promise<LocalDeletePlan> {
  const { paprDir, appId, present, roots, cachedOids, manifest } = input;
  const removed: Array<{ path: string; parentHash: string }> = [];
  const alreadyGone: string[] = [];
  for (const [p, baseOid] of manifest.files) {
    if (present.has(p) || !isUnderScannedRoot(p, roots)) continue;
    if (!(await isGone(paprDir, appId, p))) continue; // exists but no longer tracked: leave the web copy
    if (!(p in cachedOids)) {
      alreadyGone.push(p);
      continue;
    }
    removed.push({ path: p, parentHash: baseOid });
  }

  const webOnly: string[] = [];
  for (const p of Object.keys(cachedOids)) {
    if (manifest.files.has(p) || present.has(p) || WRITER_SCAFFOLD.has(p)) continue;
    if (!isUnderScannedRoot(p, roots)) continue;
    if (await isGone(paprDir, appId, p)) webOnly.push(p);
  }

  removed.sort((a, b) => a.path.localeCompare(b.path));
  webOnly.sort();
  if (removed.length <= MASS_DELETE_THRESHOLD) {
    return { deletes: removed, held: [], webOnly, alreadyGone };
  }
  return {
    deletes: removed.filter((d) => manifest.approvedDeletes.has(d.path)),
    held: removed.filter((d) => !manifest.approvedDeletes.has(d.path)).map((d) => d.path),
    webOnly,
    alreadyGone,
  };
}

export type RemoteDeleteAction =
  /** Deleted on the web, unchanged here since the last sync → delete here. */
  | { action: "delete"; filePath: string }
  /** Deleted on the web, edited here → the user chooses. */
  | { action: "delete_conflict"; filePath: string }
  /** Gone on both sides, or a schema migration (never deleted locally) → just forget. */
  | { action: "forget"; filePath: string };

/** Pull side: files someone else deleted on the web since our last sync. */
export async function planRemoteDeletes(input: {
  paprDir: string;
  appId: string;
  manifest: AppSyncManifest;
  remotePaths: ReadonlySet<string>;
}): Promise<RemoteDeleteAction[]> {
  const { paprDir, appId, manifest, remotePaths } = input;
  const out: RemoteDeleteAction[] = [];
  for (const [p, baseOid] of manifest.files) {
    if (remotePaths.has(p)) continue;
    // Applied migrations are part of the database's history: never removed here.
    if (p.startsWith("databases/")) {
      out.push({ action: "forget", filePath: p });
      continue;
    }
    const content = await readLocalRepoContent(paprDir, appId, p);
    if (content === null) {
      out.push({ action: "forget", filePath: p });
      continue;
    }
    const localOid = await computeBlobOidForContent(content);
    out.push(
      localOid === baseOid
        ? { action: "delete", filePath: p }
        : { action: "delete_conflict", filePath: p },
    );
  }
  return out.sort((a, b) => a.filePath.localeCompare(b.filePath));
}
