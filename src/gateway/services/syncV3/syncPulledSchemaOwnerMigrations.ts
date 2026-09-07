/**
 * Mirror per-app repo migrations (databases/{slug}/migrations/) into the
 * registry folder ($PAPR_HOME/data/databases/{slug}/migrations/) on pull.
 *
 * Upload reads registry → ships repo; pull must hydrate registry (not apps/{id}/).
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
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
  const normalized = repoPath.replace(/\\/g, "/");
  const match = REPO_SCHEMA_MIGRATION_PATH.exec(normalized);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { slug: match[1], fileName: match[2] };
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

/** Persist one pulled repo migration into the registry dir (missing files only). */
export async function persistPulledSchemaMigration(
  input: PersistPulledSchemaMigrationInput,
): Promise<PersistPulledSchemaMigrationOutcome> {
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
