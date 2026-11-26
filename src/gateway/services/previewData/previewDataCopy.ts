/**
 * Preview data (plan 8c): a teammate on the team's shared data (or the owner of
 * a live app, gap 2) whose change adds migrations Live doesn't have yet sees them only in Preview, on a
 * test copy (schema + up to 100 rows per table, with the pending migrations
 * applied). Live and everything else keep the team's real data. Rows entered
 * in Preview are test data: the copy is rebuilt whenever the pending change
 * changes, and dropped once nothing is pending.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AppDataSource } from "../appDataSources.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export type PreviewSource = AppDataSource & { previewCopy: true };

export function isPreviewCopySource(s: AppDataSource): s is PreviewSource {
  return (s as Partial<PreviewSource>).previewCopy === true;
}

/** Only the share-bar-v2 Preview frame asks for this (iframe URL carries pv=1; Live is /@live/). */
export function isPreviewRequest(referer: string | undefined): boolean {
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return u.searchParams.get("pv") === "1" && !u.pathname.includes("/@live/");
  } catch {
    return false;
  }
}

export function previewDataDir(appId: string, paprRoot = getPaprRoot()): string {
  return path.join(paprRoot, "data", "preview-data", appId);
}

const memo = new Map<string, { at: number; file: string | null }>();
const building = new Map<string, Promise<string | null>>();
const MEMO_MS = 3000;

export function resetPreviewDataForTests(): void {
  memo.clear();
  building.clear();
}

export interface PreviewDeps {
  isCollaboratorOnShared: (dbId: string) => boolean;
  /** Owner of a live app whose schema changes wait in Preview (gap 2). */
  isOwnerPreview?: (dbId: string) => Promise<boolean>;
  migrationRoot: (dbPath: string) => string | null;
  read: (source: AppDataSource, sql: string) => Promise<{ rows: Record<string, unknown>[] } | null>;
  paprRoot?: string;
}

async function defaultDeps(): Promise<PreviewDeps> {
  const { isCollaboratorOnSharedDatabase } = await import("../sharedPrimaryTursoResolve.js");
  const { resolveMigrationRootFromDbPath } = await import("../jobs/databaseMigrations.js");
  const { queryRegistryDatabase } = await import("../jobs/registryDbSchemaReader.js");
  const { isOwnerPreviewDatabase } = await import("./ownerPreviewData.js");
  return {
    isCollaboratorOnShared: isCollaboratorOnSharedDatabase,
    isOwnerPreview: (id) => isOwnerPreviewDatabase(id),
    migrationRoot: resolveMigrationRootFromDbPath,
    read: (s, sql) => queryRegistryDatabase({ dbPath: s.dbPath, dbId: s.dbId }, sql),
  };
}

/** The test-copy source Preview should use instead of `source`, or null for the real one. */
export async function previewSourceFor(
  appId: string,
  source: AppDataSource,
  deps?: PreviewDeps,
): Promise<PreviewSource | null> {
  if (!source.dbId) return null;
  const d = deps ?? (await defaultDeps());
  if (!d.isCollaboratorOnShared(source.dbId) && !(await (d.isOwnerPreview ?? (async () => false))(source.dbId))) return null;
  const key = `${appId}:${source.dbId}`;
  const hit = memo.get(key);
  const file =
    hit && Date.now() - hit.at < MEMO_MS
      ? hit.file
      : await (building.get(key) ??
          (() => {
            const p = ensureCopy(appId, source, d).finally(() => building.delete(key));
            building.set(key, p);
            return p;
          })());
  memo.set(key, { at: Date.now(), file });
  return file ? { ...source, dbId: undefined, dbPath: file, previewCopy: true } : null;
}

async function ensureCopy(appId: string, source: AppDataSource, d: PreviewDeps): Promise<string | null> {
  const root = d.migrationRoot(source.dbPath);
  if (!root) return null;
  const { pendingMigrations, buildTestCopy, applyMigrationsToTestCopy } = await import(
    "../cloudSync/proposalTestCopy.js"
  );
  const read = (sql: string) => d.read(source, sql);
  // Only migrations newer than the team's latest count as "your change". An
  // old file the ledgers never recorded (a leftover, an id gap) would otherwise
  // pin Preview to 100 sample rows forever.
  const team = await d.read(source, "SELECT max(id) m FROM _papr_schema_migrations").catch(() => null);
  const teamMax = String(team?.rows[0]?.m ?? "");
  const pending = (await pendingMigrations(read, root).catch(() => [])).filter((m) => m.id > teamMax);
  const dir = previewDataDir(appId, d.paprRoot);
  const prefix = `${source.dbId}-`;
  const old = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(prefix));
  if (pending.length === 0) {
    await Promise.all(old.map((n) => fs.rm(path.join(dir, n), { force: true })));
    return null;
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(pending.map((m) => [m.id, m.sql])))
    .digest("hex")
    .slice(0, 16);
  const file = path.join(dir, `${prefix}${hash}.db`);
  if (await fs.stat(file).catch(() => null)) return file;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    await buildTestCopy(read, tmp);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(tmp);
    let failed: string | undefined;
    try {
      failed = applyMigrationsToTestCopy(db, pending).failed?.error;
    } finally {
      db.close();
    }
    if (failed) {
      console.warn(`[PreviewData] ${appId}/${source.dbId}: pending change fails on a test copy (${failed}); Preview shows the team's data`);
      await fs.rm(tmp, { force: true });
      return null;
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await Promise.all(old.filter((n) => path.join(dir, n) !== file).map((n) => fs.rm(path.join(dir, n), { force: true })));
  return file;
}

export async function removePreviewData(appId: string, paprRoot = getPaprRoot()): Promise<void> {
  await fs.rm(previewDataDir(appId, paprRoot), { recursive: true, force: true });
}
