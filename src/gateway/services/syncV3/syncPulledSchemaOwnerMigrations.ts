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

export interface PersistPulledSchemaMigrationInput {
  appId: string;
  repoPath: string;
  content: string;
  remoteOid: string | undefined;
  lastSyncedOid: string | null;
  paprRoot?: string;
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
}

/** Copy one migration SQL file into the registry folder (shared pull + install + write redirect). */
export async function mirrorSchemaMigrationToRegistry(
  input: MirrorSchemaMigrationToRegistryInput,
): Promise<MirrorSchemaMigrationToRegistryOutcome> {
  const parsed = parseRepoSchemaMigrationPath(input.repoPath);
  if (!parsed) {
    return { kind: "not_migration" };
  }

  const owned = schemaOwnerSlugMapForApp(input.appId);
  if (!owned.has(parsed.slug)) {
    return { kind: "skipped", reason: "not schema owner for slug" };
  }

  const paprRoot = input.paprRoot ?? getPaprRoot();
  const registryFullPath = registryMigrationFilePath(
    paprRoot,
    parsed.slug,
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

  if (localContent !== undefined) {
    const localUnchanged =
      localOid === input.lastSyncedOid || input.lastSyncedOid === null;
    if (!localUnchanged && input.remoteOid && localOid !== input.remoteOid) {
      return { kind: "conflict" };
    }
    if (existsSync(registryFullPath)) {
      return { kind: "skipped", reason: "already on disk" };
    }
  }

  await fs.mkdir(path.dirname(registryFullPath), { recursive: true });
  await fs.writeFile(registryFullPath, input.content, { flush: true });

  const registryRelativePath = path
    .relative(paprRoot, registryFullPath)
    .replace(/\\/g, "/");

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
    const migrationsDir = path.join(databasesDir, slug, "migrations");
    const sqlFiles = await listSqlFilesInDir(migrationsDir);
    for (const fileName of sqlFiles) {
      const repoPath = `databases/${slug}/migrations/${fileName}`;
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
