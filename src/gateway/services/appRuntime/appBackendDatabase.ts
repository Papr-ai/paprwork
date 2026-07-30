/**
 * Resolve linked app database env for backend handlers (desktop + cloud).
 *
 * Injects PAPR_DB_{KEY}* for every linked source (same as job writeDbIds).
 * APP_DB / PAPR_DB_MODE / PAPR_DB_URL point at the active source for backward compat.
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  parseDataSourcesFile,
  resolveAppDataSource,
  type AppDataSource,
  type AppDataSourcesFile,
} from "../appDataSources.js";
import { resolveTursoDatabaseNameForSource } from "../DatabaseRegistryService.js";
import { databaseEnvKey } from "../jobAppDatabase.js";
import { isLocalDbReadable } from "./DbRouter.js";
import {
  resolveReadableRegistryDbPath,
} from "../resolveRegistryDbPath.js";

export type PaprDbMode = "local" | "turso";

export type TursoTokenFetcher = (
  database: string,
) => Promise<{ tursoUrl: string; authToken: string }>;

function sourceDatabaseEnvKey(source: AppDataSource): string {
  return databaseEnvKey({
    dbId: source.dbId ?? source.jobId ?? source.id,
    label: source.alias,
  });
}

async function resolveSourceConnectionEnv(
  source: AppDataSource,
  envKey: string,
  fetchTursoToken?: TursoTokenFetcher,
): Promise<Record<string, string>> {
  const prefix = `PAPR_DB_${envKey}`;
  const out: Record<string, string> = {
    [`${prefix}_ALIAS`]: source.alias,
    [`${prefix}_ID`]: source.dbId ?? source.jobId ?? "",
  };

  if (isLocalDbReadable(source.dbPath)) {
    out[prefix] = source.dbPath;
    out[`${prefix}_MODE`] = "local";
    return out;
  }

  if (!fetchTursoToken) {
    return out;
  }

  const database = resolveTursoDatabaseNameForSource(source);
  if (!database) {
    return out;
  }

  try {
    const creds = await fetchTursoToken(database);
    out[`${prefix}_MODE`] = "turso";
    out[`${prefix}_URL`] = creds.tursoUrl;
    out[`${prefix}_AUTH_TOKEN`] = creds.authToken;
    return out;
  } catch {
    return out;
  }
}

async function resolveEffectiveSource(
  source: AppDataSource,
): Promise<AppDataSource> {
  const { getDatabaseRegistryService } = await import(
    "../DatabaseRegistryService.js"
  );
  const registry = getDatabaseRegistryService();
  const record = source.dbId ? registry.getById(source.dbId) : undefined;
  const resolved = resolveReadableRegistryDbPath({
    dbPath: source.dbPath,
    registryPath: record?.localPath,
  });
  if (resolved && resolved !== source.dbPath) {
    return { ...source, dbPath: resolved };
  }
  return source;
}

async function activeSourceLegacyEnv(
  appId: string,
  source: AppDataSource,
  fetchTursoToken?: TursoTokenFetcher,
): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    APP_ID: appId,
    APP_DB_ALIAS: source.alias,
    APP_DB_JOB_ID: source.jobId ?? source.dbId ?? "",
    PAPR_ACTIVE_SOURCE_ID: source.alias,
  };

  if (isLocalDbReadable(source.dbPath)) {
    return {
      ...base,
      PAPR_DB_MODE: "local",
      APP_DB: source.dbPath,
    };
  }

  if (!fetchTursoToken) {
    return base;
  }

  const database = resolveTursoDatabaseNameForSource(source);
  if (!database) {
    return base;
  }

  try {
    const creds = await fetchTursoToken(database);
    return {
      ...base,
      PAPR_DB_MODE: "turso",
      PAPR_DB_URL: creds.tursoUrl,
      PAPR_DB_AUTH_TOKEN: creds.authToken,
    };
  } catch {
    return base;
  }
}

/**
 * Build backend handler env for all linked sources + active source legacy aliases.
 */
export async function resolveAppBackendDatabaseEnvFromConfig(input: {
  appId: string;
  config: AppDataSourcesFile;
  fetchTursoToken?: TursoTokenFetcher;
  /** Manifest default or request params.sourceId */
  sourceId?: string;
}): Promise<Record<string, string>> {
  const { config, appId, fetchTursoToken, sourceId } = input;
  if (config.sources.length === 0) {
    return {};
  }

  const env: Record<string, string> = {
    PAPR_LINKED_DB_ALIASES: config.sources.map((s) => s.alias).join(","),
  };

  for (const source of config.sources) {
    const envKey = sourceDatabaseEnvKey(source);
    const effectiveSource = await resolveEffectiveSource(source);
    Object.assign(
      env,
      await resolveSourceConnectionEnv(effectiveSource, envKey, fetchTursoToken),
    );
  }

  try {
    const active = await resolveAppDataSource(config, {
      sourceId: sourceId?.trim() || undefined,
      operation: "read",
    });
    const effectiveActive = await resolveEffectiveSource(active);
    Object.assign(
      env,
      await activeSourceLegacyEnv(appId, effectiveActive, fetchTursoToken),
    );
  } catch {
    // Multi-DB without sourceId: handlers can still use PAPR_DB_{KEY} / papr_db.connect(alias)
  }

  return env;
}

export async function resolveLocalAppBackendDatabaseEnv(input: {
  appId: string;
  paprRoot: string;
  sourceId?: string;
  fetchTursoToken?: TursoTokenFetcher;
}): Promise<Record<string, string>> {
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
    return {};
  }

  const config = parseDataSourcesFile(raw);
  const { getTursoSyncBridge } = await import("../TursoSyncBridge.js");
  const bridge = getTursoSyncBridge();
  const fetchTursoToken =
    input.fetchTursoToken ??
    (bridge ? (database) => bridge.fetchCredentials(database) : undefined);

  return resolveAppBackendDatabaseEnvFromConfig({
    appId: input.appId,
    config,
    fetchTursoToken,
    sourceId: input.sourceId,
  });
}

export async function resolveDesktopAppBackendDatabaseEnv(input: {
  appId: string;
  paprRoot: string;
  sourceId?: string;
}): Promise<Record<string, string>> {
  return resolveLocalAppBackendDatabaseEnv(input);
}

export async function resolveCloudAppBackendDatabaseEnv(input: {
  appId: string;
  config: AppDataSourcesFile;
  fetchTursoToken: TursoTokenFetcher;
  sourceId?: string;
}): Promise<Record<string, string>> {
  return resolveAppBackendDatabaseEnvFromConfig(input);
}

/** Values that must be redacted from backend stdout/stderr. */
export function collectBackendDatabaseSecrets(
  dbEnv: Record<string, string>,
): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(dbEnv)) {
    if (
      value.length > 0 &&
      (key === "PAPR_DB_AUTH_TOKEN" || key.endsWith("_AUTH_TOKEN"))
    ) {
      secrets.push(value);
    }
  }
  return secrets;
}
