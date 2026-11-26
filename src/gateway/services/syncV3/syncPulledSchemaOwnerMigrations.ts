/**
 * Mirror schema migrations into the registry apply path:
 * $PAPR_HOME/data/databases/{slug}/migrations/
 *
 * Sources that must hydrate (apply/Turso only read registry):
 * - Git pull: repo paths databases/{slug}/migrations/*.sql
 * - App tree: apps/{appId}/databases/{slug}/migrations/*.sql (fork/install/agent writes)
 *
 * Upload reads registry → ships repo; never treat app-folder SQL as applied.
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprAppsRoot, getPaprRoot } from "../../../core/utils/paprRoot.js";
import { fileContentHash } from "../../utils/fileContentHash.js";
import {
  getDatabaseRegistryService,
  registrySlugFromLocalPath,
  type DatabasesRegistryFile,
} from "../DatabaseRegistryService.js";
import { applyRegistryDatabaseMigrations } from "../jobs/databaseMigrations.js";
import { computeBlobOidForContent } from "./computeParentHash.js";

const REPO_SCHEMA_MIGRATION_PATH =
  /^databases\/([^/]+)\/migrations\/([^/]+\.sql)$/;

export function parseRepoSchemaMigrationPath(
  repoPath: string,
): { slug: string; fileName: string } | null {
  const normalized = repoPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const match = REPO_SCHEMA_MIGRATION_PATH.exec(normalized);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { slug: match[1], fileName: match[2] };
}

const APP_PREFIX_SCHEMA_MIGRATION =
  /^apps\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

/** App-relative or full paths like apps/{id}/databases/{slug}/migrations/*.sql */
export function parseAppRelativeSchemaMigrationPath(
  filePath: string,
): { slug: string; fileName: string; repoStylePath: string } | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const withoutAppPrefix = normalized.replace(APP_PREFIX_SCHEMA_MIGRATION, "");
  const parsed = parseRepoSchemaMigrationPath(withoutAppPrefix);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    repoStylePath: `databases/${parsed.slug}/migrations/${parsed.fileName}`,
  };
}

function registryMigrationFilePath(
  paprRoot: string,
  slug: string,
  fileName: string,
): string {
  return path.join(paprRoot, "data", "databases", slug, "migrations", fileName);
}

/** Slugs this app schema-owns (slug → registry db path). */
export function schemaOwnerSlugMapForApp(appId: string): Map<string, string> {
  const registry = getDatabaseRegistryService();
  const map = new Map<string, string>();
  for (const record of registry.listBySchemaOwnerApp(appId)) {
    const slug = registrySlugFromLocalPath(record.localPath);
    if (slug) {
      map.set(slug, record.localPath);
    }
  }
  return map;
}

/**
 * Schema owners from on-disk registry (cross-namespace copy / install into a
 * workspace that is not the active in-memory registry).
 */
export async function loadSchemaOwnerSlugMapFromPaprHome(
  paprRoot: string,
  appId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const trimmed = appId.trim();
  if (!trimmed) {
    return map;
  }
  const registryPath = path.join(paprRoot, "data", "databases.json");
  let registry: DatabasesRegistryFile;
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    registry = JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return map;
  }
  for (const record of Object.values(registry.databases ?? {})) {
    if (record.status !== "active" || record.schemaOwnerAppId !== trimmed) {
      continue;
    }
    const slug = registrySlugFromLocalPath(record.localPath ?? "");
    if (slug) {
      map.set(slug, record.localPath);
    }
  }
  return map;
}

async function resolveSchemaOwnerSlugMap(
  appId: string,
  paprRoot?: string,
): Promise<Map<string, string>> {
  if (paprRoot?.trim()) {
    return loadSchemaOwnerSlugMapFromPaprHome(paprRoot, appId);
  }
  return schemaOwnerSlugMapForApp(appId);
}

/**
 * The local folder for a repo database slug: the same name, or the name with a
 * short id suffix (`{slug}-{8 hex}`) when a same-named database already existed
 * on this machine at install. Never another database: a migration belongs to
 * the database named in its path, or to none.
 */
export function registrySlugForRepoSlug(owned: Map<string, string>, slug: string): string {
  if (owned.has(slug)) return slug;
  const suffixed = [...owned.keys()].filter(
    (k) => k.startsWith(`${slug}-`) && /^[0-9a-f]{8}$/.test(k.slice(slug.length + 1)),
  );
  return suffixed.length === 1 ? suffixed[0]! : slug;
}

export interface PersistPulledSchemaMigrationInput {
  appId: string;
  repoPath: string;
  content: string;
  remoteOid: string | undefined;
  lastSyncedOid: string | null;
  paprRoot?: string;
  /** Classify only — report what would happen without writing (all-or-nothing pull). */
  dryRun?: boolean;
  /** Take theirs: overwrite a conflicting local migration file with the remote one. */
  overwrite?: boolean;
}

export type PersistPulledSchemaMigrationOutcome =
  | { kind: "not_migration" }
  | { kind: "skipped"; reason: string }
  | { kind: "conflict" }
  | { kind: "written"; registryRelativePath: string }
  | { kind: "unchanged" };

export type MirrorSchemaMigrationToRegistryOutcome =
  | PersistPulledSchemaMigrationOutcome
  | { kind: "not_migration" };

export interface MirrorSchemaMigrationToRegistryInput {
  appId: string;
  /** Repo-style path: databases/{slug}/migrations/{file}.sql */
  repoPath: string;
  content: string;
  paprRoot?: string;
  remoteOid?: string;
  lastSyncedOid?: string | null;
  dryRun?: boolean;
  overwrite?: boolean;
  /** Folders this call may write (default: databases the app schema-owns). */
  slugMap?: Map<string, string>;
}

/** Copy one migration SQL file into the registry folder (shared pull + install + write redirect). */
export async function mirrorSchemaMigrationToRegistry(
  input: MirrorSchemaMigrationToRegistryInput,
): Promise<MirrorSchemaMigrationToRegistryOutcome> {
  const parsed = parseRepoSchemaMigrationPath(input.repoPath);
  if (!parsed) {
    return { kind: "not_migration" };
  }

  const owned = input.slugMap ?? (await resolveSchemaOwnerSlugMap(input.appId, input.paprRoot));
  const registrySlug = registrySlugForRepoSlug(owned, parsed.slug);
  const paprRoot = input.paprRoot ?? getPaprRoot();
  if (!owned.has(registrySlug)) {
    // Another app on this machine owns the database (a second copy of the
    // same app). If its migration is already there, byte for byte, there's
    // nothing to write: report unchanged so a pull doesn't count it as failed
    // and hold the copy's base commit back (audit D).
    try {
      const existing = await fs.readFile(
        registryMigrationFilePath(paprRoot, parsed.slug, parsed.fileName),
        "utf8",
      );
      if (fileContentHash(existing) === fileContentHash(input.content)) return { kind: "unchanged" };
    } catch {
      /* not there: fall through */
    }
    return { kind: "skipped", reason: "not schema owner for slug" };
  }

  const registryFullPath = registryMigrationFilePath(
    paprRoot,
    registrySlug,
    parsed.fileName,
  );

  let localContent: string | undefined;
  try {
    localContent = await fs.readFile(registryFullPath, "utf8");
  } catch {
    localContent = undefined;
  }

  const upstreamHash = fileContentHash(input.content);
  if (
    localContent !== undefined &&
    upstreamHash === fileContentHash(localContent)
  ) {
    return { kind: "unchanged" };
  }

  const localOid = localContent
    ? await computeBlobOidForContent(localContent)
    : null;

  if (input.remoteOid && localOid === input.remoteOid) {
    return { kind: "unchanged" };
  }

  if (localContent !== undefined && !input.overwrite) {
    const localUnchanged =
      localOid === input.lastSyncedOid || input.lastSyncedOid === null;
    if (!localUnchanged && input.remoteOid && localOid !== input.remoteOid) {
      return { kind: "conflict" };
    }
    if (existsSync(registryFullPath)) {
      // Same name, different SQL: someone edited a migration after it shipped.
      // Keep the file that ran here and say so, instead of diverging quietly
      // (audit I). The fix is a new migration, never an edit.
      console.warn(
        `[Migrations] ${parsed.fileName} changed upstream after it was written here; ` +
          "kept the local version. Applied migrations are never edited; add a new one.",
      );
      return { kind: "skipped", reason: "edited upstream after it shipped (kept local)" };
    }
  }

  const registryRelativePath = path
    .relative(paprRoot, registryFullPath)
    .replace(/\\/g, "/");

  if (input.dryRun) {
    return { kind: "written", registryRelativePath };
  }

  await fs.mkdir(path.dirname(registryFullPath), { recursive: true });
  await fs.writeFile(registryFullPath, input.content, { flush: true });

  return { kind: "written", registryRelativePath };
}

/** Persist one pulled repo migration into the registry dir (missing files only). */
export async function persistPulledSchemaMigration(
  input: PersistPulledSchemaMigrationInput,
): Promise<PersistPulledSchemaMigrationOutcome> {
  const outcome = await mirrorSchemaMigrationToRegistry({
    appId: input.appId,
    repoPath: input.repoPath,
    content: input.content,
    paprRoot: input.paprRoot,
    remoteOid: input.remoteOid,
    lastSyncedOid: input.lastSyncedOid,
    dryRun: input.dryRun,
    overwrite: input.overwrite,
  });
  if (outcome.kind === "not_migration") {
    return { kind: "not_migration" };
  }
  return outcome;
}

async function listSqlFilesInDir(dir: string): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

/**
 * Scan apps/{appId}/databases/{slug}/migrations/*.sql and mirror missing files
 * into data/databases/{slug}/migrations/ (fork/install/copy path).
 */
export async function hydrateAppFolderSchemaMigrationsToRegistry(input: {
  appId: string;
  paprRoot?: string;
  appsRoot?: string;
  /**
   * Also every database the app links, not only the ones it schema-owns
   * (Propose: one migrations folder per database, so a copy that doesn't own
   * the schema is checked and tested like the owner — audit E).
   */
  includeLinked?: boolean;
}): Promise<{ copied: string[]; skipped: string[] }> {
  const paprRoot = input.paprRoot ?? getPaprRoot();
  const appDir =
    input.appsRoot !== undefined
      ? path.join(input.appsRoot, input.appId)
      : path.join(getPaprAppsRoot(), input.appId);
  const databasesDir = path.join(appDir, "databases");
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(databasesDir)) {
    return { copied, skipped };
  }

  let slugEntries: import("fs").Dirent[];
  try {
    slugEntries = await fs.readdir(databasesDir, { withFileTypes: true });
  } catch {
    return { copied, skipped };
  }

  for (const slugEntry of slugEntries) {
    if (!slugEntry.isDirectory()) {
      continue;
    }
    const slug = slugEntry.name;
    const owned = await resolveSchemaOwnerSlugMap(input.appId, input.paprRoot);
    if (input.includeLinked) {
      for (const [k, v] of await linkedSlugMapForApp(paprRoot, appDir)) if (!owned.has(k)) owned.set(k, v);
    }
    const registrySlug = registrySlugForRepoSlug(owned, slug);
    const migrationsDir = path.join(databasesDir, slug, "migrations");
    const sqlFiles = await listSqlFilesInDir(migrationsDir);
    for (const fileName of sqlFiles) {
      const repoPath = `databases/${registrySlug}/migrations/${fileName}`;
      // A declined proposal's migration is moved to _quarantine in the real
      // folder. The app-folder copy must not bring it back (audit C).
      if (isQuarantined(paprRoot, owned.get(registrySlug), fileName)) {
        skipped.push(`${repoPath} (declined; in _quarantine)`);
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(path.join(migrationsDir, fileName), "utf8");
      } catch {
        skipped.push(repoPath);
        continue;
      }
      const outcome = await mirrorSchemaMigrationToRegistry({
        appId: input.appId,
        repoPath,
        content,
        paprRoot,
        slugMap: owned,
      });
      if (outcome.kind === "written") {
        copied.push(outcome.registryRelativePath);
      } else if (outcome.kind === "unchanged") {
        skipped.push(repoPath);
      } else if (outcome.kind === "skipped") {
        skipped.push(`${repoPath} (${outcome.reason})`);
      } else if (outcome.kind === "conflict") {
        skipped.push(`${repoPath} (conflict)`);
      } else {
        skipped.push(repoPath);
      }
    }
  }

  return { copied, skipped };
}

function isQuarantined(paprRoot: string, dbPath: string | undefined, fileName: string): boolean {
  const slug = dbPath ? registrySlugFromLocalPath(dbPath) : null;
  if (!slug) return false;
  const q = path.join(paprRoot, "data", "databases", slug, "migrations", "_quarantine");
  return existsSync(path.join(q, fileName)) || existsSync(path.join(q, `${fileName}.rejected`));
}

/**
 * Is a repo path a migration for a database this copy doesn't link? The
 * publisher's repo can carry databases the copy never got (a test database, one
 * linked later and unlinked). Those files have nowhere to go here: Get updates
 * skips them instead of counting them as failed writes, which would hold the
 * copy's base commit back forever.
 */
export async function isUnlinkedDatabaseMigrationPath(
  appId: string,
  repoPath: string,
  paprRoot: string = getPaprRoot(),
): Promise<boolean> {
  const m = /^databases\/([^/]+)\/migrations\//.exec(repoPath);
  if (!m) return false;
  const appDir = path.join(getPaprAppsRoot(), appId);
  const linked = await linkedSlugMapForApp(paprRoot, appDir);
  for (const [k, v] of await resolveSchemaOwnerSlugMap(appId)) if (!linked.has(k)) linked.set(k, v);
  if (linked.size === 0) return false; // can't tell: keep the old behaviour
  return !linked.has(registrySlugForRepoSlug(linked, m[1]!));
}

/** Slugs of every registry database an app links (data-sources.json), slug → db path. */
async function linkedSlugMapForApp(paprRoot: string, appDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let ids: string[] = [];
  let registry: DatabasesRegistryFile;
  try {
    const raw = await fs.readFile(path.join(appDir, "data-sources.json"), "utf8");
    ids = raw.match(/db-[0-9a-f]{8}(?![0-9a-f])/g) ?? [];
    registry = JSON.parse(await fs.readFile(path.join(paprRoot, "data", "databases.json"), "utf8")) as DatabasesRegistryFile;
  } catch {
    return map;
  }
  for (const id of new Set(ids)) {
    const record = registry.databases?.[id];
    if (!record || record.status !== "active") continue;
    const slug = registrySlugFromLocalPath(record.localPath ?? "");
    if (slug) map.set(slug, record.localPath);
  }
  return map;
}

/** Apply pending registry migrations for every DB this app schema-owns. */
export async function applyRegistryMigrationsAfterPull(
  appId: string,
): Promise<string[]> {
  const owned = schemaOwnerSlugMapForApp(appId);
  const applied: string[] = [];
  for (const dbPath of owned.values()) {
    const ids = await applyRegistryDatabaseMigrations(dbPath);
    const slug = registrySlugFromLocalPath(dbPath) ?? dbPath;
    for (const id of ids) {
      applied.push(`${slug}:${id}`);
    }
  }
  return applied;
}
