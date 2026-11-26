/**
 * A migration filed under the wrong database.
 *
 * Created migrations are named NNNN_<14-digit timestamp>_<name>, so one file
 * belongs to exactly one database. Older builds (the "only database this app
 * owns" guess, removed in #1058) copied a database's migration into another
 * database's folder, and proposing then published it there. Deleting it on the
 * web never removes it from computers that already pulled it (migrations are
 * history), so it stays pending forever and every Propose fails on it.
 *
 * Misfiled, from facts only:
 *   - stamped name (baselines exist in every folder and are never misfiled)
 *   - not applied to this database (neither ledger)
 *   - the identical file (same name, same SQL) is in another database's folder
 *     and is applied there
 *   - that database is a different one, not a copy of this one: their applied
 *     histories share no stamped migration, and this one has applied at least
 *     one. A copy (fresh, behind, or diverged) shares its early history, so it
 *     is never touched; nor is {slug} vs {slug}-{8 hex}.
 * A misfiled file is moved to _quarantine (never deleted, never run, never
 * proposed). Anything unreadable is left alone.
 */

import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";

import { QUARANTINE_DIR } from "./consolidateMigrationFolders.js";
import { hashSql } from "./restoredMigrations.js";

const STAMPED = /^\d{4}_\d{14}_.+\.sql$/;

export interface MigrationFolder {
  dbId: string;
  /** Folder name under data/databases (e.g. team-data-680 or notes-59e5ad02). */
  slug: string;
  /** .../data/databases/{slug}/migrations */
  dir: string;
}

export type LedgerReader = (folder: MigrationFolder) => Promise<ReadonlySet<string> | null>;

export interface MisfiledMigration {
  file: string;
  /** Where it is. */
  folder: MigrationFolder;
  /** Where it belongs (same file, applied there). */
  belongsTo: MigrationFolder;
}

/** `notes-59e5ad02` → `notes`: own-data copies of one database share a base name. */
export function baseSlug(slug: string): string {
  return slug.replace(/-[0-9a-f]{8}$/, "");
}

async function stampedFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    if (!STAMPED.test(n)) continue;
    const sql = await fs.readFile(path.join(dir, n), "utf8").catch(() => null);
    if (sql !== null) out.set(n, hashSql(sql));
  }
  return out;
}

export async function findMisfiledMigrations(
  folders: readonly MigrationFolder[],
  readLedger: LedgerReader,
): Promise<MisfiledMigration[]> {
  const files = new Map<string, Map<string, string>>();
  for (const f of folders) files.set(f.dbId, await stampedFiles(f.dir));
  const ledgers = new Map<string, ReadonlySet<string> | null>();
  const ledger = async (f: MigrationFolder) => {
    if (!ledgers.has(f.dbId)) ledgers.set(f.dbId, await readLedger(f).catch(() => null));
    return ledgers.get(f.dbId) ?? null;
  };

  const out: MisfiledMigration[] = [];
  for (const here of folders) {
    for (const [file, hash] of files.get(here.dbId) ?? []) {
      const twins = folders.filter(
        (o) => o.dbId !== here.dbId && baseSlug(o.slug) !== baseSlug(here.slug) && files.get(o.dbId)?.get(file) === hash,
      );
      if (twins.length === 0) continue;
      const mine = await ledger(here);
      const id = file.replace(/\.sql$/, "");
      if (!mine || mine.has(id)) continue;
      for (const o of twins) {
        const theirs = await ledger(o);
        if (!theirs?.has(id)) continue;
        // Different databases: disjoint stamped histories (a copy shares its early ones).
        const stamped = [...mine].filter((m) => /^\d{4}_\d{14}_/.test(m));
        const different = stamped.length > 0 && stamped.every((m) => !theirs.has(m));
        if (different) {
          out.push({ file, folder: here, belongsTo: o });
          break;
        }
      }
    }
  }
  return out;
}

/** Move misfiled files to _quarantine. Returns what moved. */
export async function quarantineMisfiledMigrations(
  folders: readonly MigrationFolder[],
  readLedger: LedgerReader,
): Promise<MisfiledMigration[]> {
  const found = await findMisfiledMigrations(folders, readLedger);
  const moved: MisfiledMigration[] = [];
  for (const m of found) {
    const q = path.join(m.folder.dir, QUARANTINE_DIR);
    const to = path.join(q, m.file);
    try {
      await fs.mkdir(q, { recursive: true });
      if (existsSync(to)) await fs.rm(path.join(m.folder.dir, m.file), { force: true });
      else await fs.rename(path.join(m.folder.dir, m.file), to);
      moved.push(m);
    } catch {
      /* left in place; Propose reports it */
    }
  }
  return moved;
}

/**
 * For one app: every active registry database is searched for twins, but only
 * the folders of databases this app links are cleaned. Ledger = this copy's
 * schema_migrations plus the team ledger (_papr_schema_migrations).
 */
export async function quarantineMisfiledForApp(paprDir: string, appId: string): Promise<MisfiledMigration[]> {
  const { readDataSourceRegistryDbIds } = await import("../cloudSync/resolveAppDependentJobs.js");
  const { registrySlugFromLocalPath } = await import("../DatabaseRegistryService.js");
  const { queryRegistryDatabase } = await import("./registryDbSchemaReader.js");
  let registry: { databases?: Record<string, { status?: string; localPath?: string }> };
  try {
    registry = JSON.parse(await fs.readFile(path.join(paprDir, "data", "databases.json"), "utf8"));
  } catch {
    return [];
  }
  const linked = new Set(readDataSourceRegistryDbIds(paprDir, appId));
  if (linked.size === 0) return [];
  const folders: MigrationFolder[] = [];
  const dbPaths = new Map<string, string>();
  for (const [dbId, r] of Object.entries(registry.databases ?? {})) {
    if (r.status !== "active" || !r.localPath) continue;
    const slug = registrySlugFromLocalPath(r.localPath);
    if (!slug) continue;
    folders.push({ dbId, slug, dir: path.join(path.dirname(r.localPath), "migrations") });
    dbPaths.set(dbId, r.localPath);
  }
  const readLedger: LedgerReader = async (f) => {
    const input = { dbPath: dbPaths.get(f.dbId)!, dbId: f.dbId };
    const own = await queryRegistryDatabase(input, "SELECT id FROM schema_migrations");
    if (!own) return null;
    const team = await queryRegistryDatabase(input, "SELECT id FROM _papr_schema_migrations").catch(() => null);
    const ids = new Set<string>();
    for (const r of [...own.rows, ...(team?.rows ?? [])]) ids.add(String(r.id ?? "").replace(/\.sql$/, ""));
    return ids;
  };
  const found = await findMisfiledMigrations(folders, readLedger);
  const inApp = found.filter((m) => linked.has(m.folder.dbId));
  if (inApp.length === 0) return [];
  const moved = await quarantineMisfiledMigrations(
    folders.filter((f) => linked.has(f.dbId)),
    readLedger,
  );
  for (const m of moved) {
    console.warn(
      `[Migrations] ${m.file} was filed under ${m.folder.slug} but belongs to ${m.belongsTo.slug}; moved to ${m.folder.slug}/migrations/${QUARANTINE_DIR}`,
    );
  }
  return moved;
}
