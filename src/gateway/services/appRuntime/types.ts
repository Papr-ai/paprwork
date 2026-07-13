/**
 * Shared types for mini-app runtime (local desktop gateway + cloud app host).
 */

import type { AppDataSource, AppDataSourcesFile } from "../appDataSources.js";

export type AppRuntimeMode = "local" | "cloud";

/** Who is calling /api/db/* — resolved before SQL execution. */
export type AppAccessMode =
  | "owner"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

export interface AppAccessContext {
  orgId: string;
  namespaceId: string;
  userId: string;
  appId: string;
  mode: AppAccessMode;
  canRead: boolean;
  canWrite: boolean;
}

export interface DbQueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  count: number;
  source?: string;
  /** True when the result was cut off at the server-side row cap. */
  truncated?: boolean;
}

export interface DbWriteResult {
  changes: number;
  lastInsertRowid: number;
  source?: string;
}

export interface DbSchemaTable {
  table: string;
  columns: Array<{ name: string; type: string; pk: boolean }>;
}

export interface DbSchemaSource {
  sourceId: string;
  alias: string;
  tables: DbSchemaTable[];
  error?: string;
}

export interface AppFileProvider {
  readAppFile(appId: string, relativePath: string): Promise<string | null>;
  resolveAppFilePath(appId: string, relativePath: string): Promise<string | null>;
}

export interface AppDataSourceProvider {
  getDataSourcesConfig(appId: string): Promise<AppDataSourcesFile>;
}

export interface AppRuntimeRouteAuth {
  namespaceId: string;
  slug: string;
  paprApiKey?: string;
  sessionToken?: string;
  shareToken?: string;
}

export interface TursoCredentialsProvider {
  getUserDatabaseToken(
    orgId: string,
    namespaceId: string,
    userId: string,
    runtimeAuth: AppRuntimeRouteAuth,
    database: string,
  ): Promise<{ tursoUrl: string; authToken: string }>;
}

export interface AppPublishResolver {
  validateAccess(input: {
    namespaceId: string;
    slug: string;
    paprApiKey?: string;
    sessionToken?: string;
    shareToken?: string;
  }): Promise<AppAccessContext | null>;
}

export interface ResolvedCloudSource {
  source: AppDataSource;
  remoteSql: string;
}
