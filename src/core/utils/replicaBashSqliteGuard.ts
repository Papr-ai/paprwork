/**
 * Block bash/sqlite3 writes against Plan A replica-managed DB files — use papr_db_* instead.
 */

import fs from "fs";
import path from "path";
import {
  collectPaprDbPathsFromEnv,
  commandHasSqliteWrite,
  extractSqliteDbPaths,
  type SqlitePathGuardContext,
} from "./sqlitePathGuard.js";
import {
  isPlanACloudEnvFromProcessEnv,
  REPLICA_BASH_SQLITE_MSG,
} from "./planADbMessages.js";
import { getPaprDataDir } from "./paprRoot.js";

type DatabaseSyncMode = "legacy" | "replica";

interface RegistryRecordLite {
  localPath: string;
  syncMode?: DatabaseSyncMode;
  status: string;
}

interface RegistryFileLite {
  databases: Record<string, RegistryRecordLite>;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, p.slice(2));
  }
  return p;
}

function normalizeDbPath(p: string): string {
  return path.resolve(expandHome(p.replace(/^["']|["']$/g, "")));
}

function posixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/** Registry DB layout: data/databases/{slug}/data.db */
export function isRegistryDatabasePath(resolvedPath: string): boolean {
  return /\/data\/databases\/[^/]+\/data\.db$/i.test(posixPath(resolvedPath));
}

function tursoReplicaRolloutMode(
  env: NodeJS.ProcessEnv,
): "off" | "replica-records" | "force" {
  const raw = env.PAPR_TURSO_REPLICA_SYNC?.trim().toLowerCase();
  if (raw === "force" || raw === "true" || raw === "1") {
    return "force";
  }
  if (raw === "replica-records" || raw === "records") {
    return "replica-records";
  }
  return "off";
}

function shouldBlockReplicaManagedRecord(
  record: RegistryRecordLite,
  env: NodeJS.ProcessEnv,
): boolean {
  const rollout = tursoReplicaRolloutMode(env);
  if (rollout === "force") {
    return true;
  }
  return record.syncMode === "replica";
}

function resolveDatabasesRegistryPath(env: NodeJS.ProcessEnv): string {
  const explicitHome = env.PAPR_HOME?.trim();
  if (explicitHome) {
    return path.join(path.resolve(explicitHome), "data", "databases.json");
  }
  return path.join(getPaprDataDir(), "databases.json");
}

let registryCache:
  | { registryPath: string; mtimeMs: number; byPath: Map<string, RegistryRecordLite> }
  | null = null;

function loadRegistryByPath(env: NodeJS.ProcessEnv): Map<string, RegistryRecordLite> {
  const registryPath = resolveDatabasesRegistryPath(env);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(registryPath).mtimeMs;
  } catch {
    return new Map();
  }

  if (
    registryCache &&
    registryCache.registryPath === registryPath &&
    registryCache.mtimeMs === mtimeMs
  ) {
    return registryCache.byPath;
  }

  const byPath = new Map<string, RegistryRecordLite>();
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as RegistryFileLite;
    for (const record of Object.values(parsed.databases ?? {})) {
      if (record.status !== "active") {
        continue;
      }
      byPath.set(normalizeDbPath(record.localPath), record);
    }
  } catch {
    /* missing or corrupt registry */
  }

  registryCache = { registryPath, mtimeMs, byPath };
  return byPath;
}

/** True when databases.json marks this path as Plan A replica-managed. */
export function isReplicaManagedDbPathFromRegistry(
  resolvedPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isPlanACloudEnvFromProcessEnv(env)) {
    return false;
  }
  const record = loadRegistryByPath(env).get(normalizeDbPath(resolvedPath));
  if (!record) {
    return false;
  }
  return shouldBlockReplicaManagedRecord(record, env);
}

function collectDbTargets(
  command: string,
  ctx: SqlitePathGuardContext = {},
): string[] {
  const envSource = ctx.env ?? process.env;
  const targets = new Set<string>();

  for (const raw of extractSqliteDbPaths(command)) {
    if (/^\$/.test(raw)) {
      const varName = raw.replace(/^\$\{?|\}?$/g, "");
      const value = envSource[varName];
      if (typeof value === "string" && value.length > 0) {
        targets.add(normalizeDbPath(value));
      }
      continue;
    }
    targets.add(normalizeDbPath(raw));
  }

  if (ctx.appDb) {
    targets.add(normalizeDbPath(ctx.appDb));
  }
  if (ctx.jobDb) {
    targets.add(normalizeDbPath(ctx.jobDb));
  }
  for (const p of collectPaprDbPathsFromEnv(envSource)) {
    targets.add(normalizeDbPath(p));
  }

  return [...targets];
}

export interface ReplicaBashSqliteBlock {
  message: string;
}

/**
 * Hard-block sqlite3 / Python sqlite writes to Plan A replica-managed DB files.
 */
export function detectReplicaRegistrySqliteBlock(
  command: string,
  ctx: SqlitePathGuardContext = {},
): ReplicaBashSqliteBlock | null {
  const env = ctx.env ?? process.env;
  if (!isPlanACloudEnvFromProcessEnv(env)) {
    return null;
  }
  if (!commandHasSqliteWrite(command)) {
    return null;
  }

  for (const target of collectDbTargets(command, ctx)) {
    if (isRegistryDatabasePath(target)) {
      return { message: REPLICA_BASH_SQLITE_MSG };
    }
    if (isReplicaManagedDbPathFromRegistry(target, env)) {
      return { message: REPLICA_BASH_SQLITE_MSG };
    }
  }

  return null;
}

/** Test-only: clear databases.json lookup cache. */
export function resetReplicaRegistryCacheForTests(): void {
  registryCache = null;
}
