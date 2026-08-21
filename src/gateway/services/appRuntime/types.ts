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

/** GET /api/access — mini-apps use this to gate admin UI and owner-only flows. */
export interface MiniAppAccessResponse {
  mode: AppAccessMode | null;
  canRead: boolean;
  canWrite: boolean;
  loggedIn: boolean;
  isOwner: boolean;
  /** Caller's Parse objectId — present when loggedIn; use for row filters (not publisher). */
  userId?: string;
  /** Same as userId — mirrors cloud API external_user_id naming. */
  externalUserId?: string;
  /** Publish-catalog owner Parse id — for admin comparisons, not row ACL. */
  publisherUserId?: string;
  /** Caller's email when known (session). */
  email?: string;
  appId?: string;
}

/** GET /api/members — Papr workspace roster for role assignment UIs. */
export interface MiniAppWorkspaceMember {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  profileImageUrl?: string;
}

export interface MiniAppMembersResponse {
  workspaceId: string;
  workspaceName?: string;
  namespaceId?: string;
  members: MiniAppWorkspaceMember[];
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

export interface DbWriteBatchStatement {
  sourceId?: string;
  sql: string;
  params?: unknown[];
}

export interface DbWriteBatchResultItem extends DbWriteResult {
  ok: boolean;
  error?: string;
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
  /** Parse _User.objectId from apps.papr.ai sign-in (same as desktop external_user_id). */
  externalUserId?: string;
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
    externalUserId?: string;
  }): Promise<AppAccessContext | null>;
}

export interface ResolvedCloudSource {
  source: AppDataSource;
  remoteSql: string;
}
