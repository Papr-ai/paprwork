/**
 * Publish completion record.
 *
 * Registering an app on the memory server is not the same as publishing it:
 * code and database uploads finish later, on this desktop. Installers used to
 * clone HEAD the moment the app was registered — sometimes mid-upload.
 *
 * After flushAppNow proves the app is web-ready (code synced AND every linked
 * cloud database in sync), we tell the server exactly what landed: the commit
 * and each database's latest cloud migration. Catalog and install read that.
 */
import { cloudApiFetch } from "../../utils/cloudApiClient.js";

export interface PublishedRevision {
  commit: string;
  dbSchema?: Record<string, string>;
  completedAt?: string;
}

/** Latest migration id each linked database has in the CLOUD (not local). */
export async function readCloudDbSchema(
  sources: ReadonlyArray<{ dbId?: string; tursoDatabase?: string }>,
): Promise<Record<string, string>> {
  const { readRemoteTursoMigrationIds } = await import(
    "../tursoReplica/tursoReplicaMigrationConflict.js"
  );
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (!source.dbId || !source.tursoDatabase || out[source.dbId]) continue;
    try {
      const ids = await readRemoteTursoMigrationIds(source.tursoDatabase);
      const latest = [...ids].sort().at(-1);
      if (latest) out[source.dbId] = latest;
    } catch {
      /* unreachable DB: omit — installer then just skips the schema check for it */
    }
  }
  return out;
}

export async function reportPublishComplete(
  appId: string,
  revision: { commit: string; dbSchema: Record<string, string> },
): Promise<PublishedRevision | null> {
  const response = await cloudApiFetch(
    `/v1/cloud/apps/publish/${encodeURIComponent(appId)}/complete`,
    { method: "POST", body: revision, timeoutMs: 15_000 },
  );
  if (response.status === 404) return null; // not published (private sync only)
  if (!response.ok) {
    throw new Error(`Publish completion failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
  }
  return (await response.json()) as PublishedRevision;
}

/**
 * Which commit an installer should check out.
 * - finished publish → its commit
 * - first publish still uploading → refuse (caller shows "still publishing")
 * - legacy publish (no record either way) → HEAD, as before
 */
export function installCommitFor(prepare: {
  publishedRevision?: PublishedRevision | null;
  publishPending?: boolean;
}): { commit: string | null; blocked: boolean } {
  const commit = prepare.publishedRevision?.commit?.trim() || null;
  if (commit) return { commit, blocked: false };
  return { commit: null, blocked: prepare.publishPending === true };
}

/** dbIds whose cloud schema is behind what the publisher's completed publish recorded. */
export function schemaBehindPublish(
  expected: Record<string, string> | undefined,
  actual: Record<string, string>,
): string[] {
  if (!expected) return [];
  return Object.entries(expected)
    .filter(([dbId, migration]) => actual[dbId] !== undefined && actual[dbId]! < migration)
    .map(([dbId]) => dbId);
}
