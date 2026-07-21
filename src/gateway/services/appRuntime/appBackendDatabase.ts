/**
 * Resolve linked app database env for backend handlers (desktop + cloud).
 *
 * Mirrors job APP_DB injection but adds Turso credentials when local SQLite
 * is unavailable — same routing semantics as DbRouter / TursoDbAdapter.
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  getPrimarySource,
  parseDataSourcesFile,
  type AppDataSource,
  type AppDataSourcesFile,
} from "../appDataSources.js";
import { resolveTursoDatabaseNameForSource } from "../DatabaseRegistryService.js";
import { isLocalDbReadable } from "./DbRouter.js";

export type PaprDbMode = "local" | "turso";

export interface AppBackendDatabaseEnv {
  APP_ID: string;
  APP_DB_ALIAS: string;
  APP_DB_JOB_ID: string;
  PAPR_DB_MODE: PaprDbMode;
  /** Local SQLite path — use with sqlite3 when PAPR_DB_MODE=local */
  APP_DB?: string;
  /** libsql URL — use when PAPR_DB_MODE=turso */
  PAPR_DB_URL?: string;
  PAPR_DB_AUTH_TOKEN?: string;
}

export type TursoTokenFetcher = (
  database: string,
) => Promise<{ tursoUrl: string; authToken: string }>;

function baseFields(
  appId: string,
  source: AppDataSource,
): Pick<
  AppBackendDatabaseEnv,
  "APP_ID" | "APP_DB_ALIAS" | "APP_DB_JOB_ID"
> {
  return {
    APP_ID: appId,
    APP_DB_ALIAS: source.alias,
    APP_DB_JOB_ID: source.jobId ?? source.dbId ?? "",
  };
}

export function appBackendDatabaseEnvRecord(
  env: AppBackendDatabaseEnv,
): Record<string, string> {
  const out: Record<string, string> = {
    APP_ID: env.APP_ID,
    APP_DB_ALIAS: env.APP_DB_ALIAS,
    APP_DB_JOB_ID: env.APP_DB_JOB_ID,
    PAPR_DB_MODE: env.PAPR_DB_MODE,
  };
  if (env.APP_DB) {
    out.APP_DB = env.APP_DB;
  }
  if (env.PAPR_DB_URL) {
    out.PAPR_DB_URL = env.PAPR_DB_URL;
  }
  if (env.PAPR_DB_AUTH_TOKEN) {
    out.PAPR_DB_AUTH_TOKEN = env.PAPR_DB_AUTH_TOKEN;
  }
  return out;
}

export async function resolveLocalAppBackendDatabaseEnv(input: {
  appId: string;
  paprRoot: string;
  fetchTursoToken?: TursoTokenFetcher;
}): Promise<AppBackendDatabaseEnv | null> {
  const dsPath = path.join(
    input.paprRoot,
    "apps",
    input.appId,
    "data-sources.json",
  );
  let raw: string;
  try {
    raw = await fs.readFile(dsPath, "utf8");
  } catch {
    return null;
  }

  const config = parseDataSourcesFile(raw);
  return resolveAppBackendDatabaseEnvFromConfig({
    appId: input.appId,
    config,
    fetchTursoToken: input.fetchTursoToken,
  });
}

export async function resolveAppBackendDatabaseEnvFromConfig(input: {
  appId: string;
  config: AppDataSourcesFile;
  fetchTursoToken?: TursoTokenFetcher;
}): Promise<AppBackendDatabaseEnv | null> {
  const primary = getPrimarySource(input.config);
  if (!primary?.dbPath) {
    return null;
  }

  const base = baseFields(input.appId, primary);

  if (isLocalDbReadable(primary.dbPath)) {
    return {
      ...base,
      PAPR_DB_MODE: "local",
      APP_DB: primary.dbPath,
    };
  }

  if (!input.fetchTursoToken) {
    return null;
  }

  try {
    const database = resolveTursoDatabaseNameForSource(primary);
    if (!database) {
      return null;
    }
    const creds = await input.fetchTursoToken(database);
    return {
      ...base,
      PAPR_DB_MODE: "turso",
      PAPR_DB_URL: creds.tursoUrl,
      PAPR_DB_AUTH_TOKEN: creds.authToken,
    };
  } catch {
    return null;
  }
}

export async function resolveDesktopAppBackendDatabaseEnv(input: {
  appId: string;
  paprRoot: string;
}): Promise<Record<string, string>> {
  const { getTursoSyncBridge } = await import("../TursoSyncBridge.js");
  const bridge = getTursoSyncBridge();
  const env = await resolveLocalAppBackendDatabaseEnv({
    appId: input.appId,
    paprRoot: input.paprRoot,
    fetchTursoToken: bridge
      ? (database) => bridge.fetchCredentials(database)
      : undefined,
  });
  return env ? appBackendDatabaseEnvRecord(env) : {};
}

export async function resolveCloudAppBackendDatabaseEnv(input: {
  appId: string;
  config: AppDataSourcesFile;
  fetchTursoToken: TursoTokenFetcher;
}): Promise<Record<string, string>> {
  const env = await resolveAppBackendDatabaseEnvFromConfig({
    appId: input.appId,
    config: input.config,
    fetchTursoToken: input.fetchTursoToken,
  });
  return env ? appBackendDatabaseEnvRecord(env) : {};
}

/** Values that must be redacted from backend stdout/stderr. */
export function collectBackendDatabaseSecrets(
  dbEnv: Record<string, string>,
): string[] {
  const token = dbEnv.PAPR_DB_AUTH_TOKEN;
  return token && token.length > 0 ? [token] : [];
}
