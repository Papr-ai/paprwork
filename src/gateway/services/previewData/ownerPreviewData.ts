/**
 * Owner Preview data (gap 2, plan rule 3): once an app is live, the owner's
 * new schema changes go through Preview first, like a teammate's. The change
 * runs on a test copy (Preview shows it, jobs started from Preview use it);
 * the real database gets it when the owner publishes, right before the code,
 * so Live never runs old code on a new schema or new code on an old one.
 *
 * Opt-in with share bar v2 (PAPR_OWNER_PREVIEW_DATA=1): without the Preview
 * view, a held change would be invisible and the local app would break. Not
 * live yet (no Live copy on this desktop), per-user databases and cloud runs
 * keep the old behaviour either way: apply right away.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";

const publishing = new Set<string>();

/** Publish applies the owner's pending changes for real inside this. */
export async function withOwnerPublishApply<T>(dbId: string, fn: () => Promise<T>): Promise<T> {
  publishing.add(dbId);
  try {
    return await fn();
  } finally {
    publishing.delete(dbId);
  }
}

/** Apps on this desktop that link dbId and are live (have a Live copy). */
function liveAppsLinking(dbId: string, paprRoot: string): string[] {
  const appsDir = path.join(paprRoot, "apps");
  let ids: string[] = [];
  try {
    ids = readdirSync(appsDir);
  } catch {
    return [];
  }
  return ids.filter((appId) => {
    try {
      if (!readFileSync(path.join(appsDir, appId, "data-sources.json"), "utf8").includes(dbId)) return false;
    } catch {
      return false;
    }
    return existsSync(path.join(paprRoot, "data", "live-code", appId, "index.html"));
  });
}

export interface OwnerPreviewDeps {
  isCollaboratorOnShared: (dbId: string) => boolean;
  record: (dbId: string) => { isolation?: string } | undefined;
  isCloudRun: () => boolean;
  paprRoot?: string;
}

async function defaultDeps(): Promise<OwnerPreviewDeps> {
  const { isCollaboratorOnSharedDatabase } = await import("../sharedPrimaryTursoResolve.js");
  const { getDatabaseRegistryService } = await import("../DatabaseRegistryService.js");
  const { isCloudRunSandbox } = await import("../cloudAgentGateway/cloudSandboxTursoDirect.js");
  return {
    isCollaboratorOnShared: isCollaboratorOnSharedDatabase,
    record: (id) => getDatabaseRegistryService().getById(id),
    isCloudRun: () => isCloudRunSandbox(),
  };
}

/** Owner's database whose new schema changes wait in Preview until publish. */
export async function isOwnerPreviewDatabase(dbId: string, deps?: OwnerPreviewDeps): Promise<boolean> {
  if (process.env.PAPR_OWNER_PREVIEW_DATA !== "1" || publishing.has(dbId)) return false;
  const d = deps ?? (await defaultDeps());
  if (d.isCloudRun() || d.isCollaboratorOnShared(dbId)) return false;
  const rec = d.record(dbId);
  if (!rec || rec.isolation === "per-user") return false;
  return liveAppsLinking(dbId, d.paprRoot ?? getPaprRoot()).length > 0;
}

/**
 * Publish step (database first, then code): apply each pending change on the
 * real database. Throws on the first failure so the code isn't published.
 */
export async function applyOwnerPendingForPublish(
  paprDir: string,
  appId: string,
  onProgress?: (label: string, detail?: string) => void,
): Promise<string[]> {
  if (process.env.PAPR_OWNER_PREVIEW_DATA !== "1") return [];
  const { listAppLinkedSyncKeys } = await import("../tursoLinkedSources.js");
  const { getDatabaseRegistryService } = await import("../DatabaseRegistryService.js");
  const { resolveMigrationRootFromDbPath } = await import("../jobs/databaseMigrations.js");
  const { queryRegistryDatabase } = await import("../jobs/registryDbSchemaReader.js");
  const { pendingMigrations } = await import("../cloudSync/proposalTestCopy.js");
  const { paprDbApplyMigration } = await import("../tursoReplica/PaprDbService.js");
  const applied: string[] = [];
  for (const dbId of listAppLinkedSyncKeys(appId, paprDir)) {
    if (!(await isOwnerPreviewDatabase(dbId))) continue;
    const rec = getDatabaseRegistryService().getById(dbId);
    const root = rec ? resolveMigrationRootFromDbPath(rec.localPath) : null;
    if (!rec || !root) continue;
    const pending = await pendingMigrations((sql) => queryRegistryDatabase({ dbPath: rec.localPath, dbId }, sql), root);
    if (pending.length === 0) continue;
    onProgress?.("Publishing database change…", `Applying ${pending.length} schema change(s) to ${rec.label ?? dbId}.`);
    await withOwnerPublishApply(dbId, async () => {
      for (const m of pending) {
        const r = await paprDbApplyMigration({ dbId, migrationId: m.id });
        if (!r.applied && !r.replicaApplied) throw new Error(`${m.id} didn't apply to ${rec.label ?? dbId}; nothing was published`);
        applied.push(m.id);
      }
    });
  }
  return applied;
}
