/**
 * Execute mini-app SQL against Turso (cloud mode).
 * Credentials are server-held only — never sent to browsers.
 * One Turso database per linked job source.
 */

import { capReadSql, capRows, MAX_READ_ROWS } from "./dbRequestGuard.js";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  bumpRemoteSyncVersion,
  filterSyncableTables,
  quoteIdent,
  readRemoteSyncVersion,
} from "../tursoSyncBridgeCore.js";
import {
  ensureRemoteSyncInfrastructure,
  ensureRemoteTableSyncTriggers,
  remoteInsertTriggersCoverSyncableTables,
} from "../tursoSyncLog.js";
import { writeRemoteCdcReadyMarker } from "./cloudRemoteCdcReadyCache.js";
import { jobTursoDatabaseName } from "../tursoDatabaseNaming.js";
import { shouldSkipMigrationForRemoteLedger } from "../jobs/migrationLedgerPolicy.js";
import {
  getDatabaseRegistryService,
  privateTablesOf,
  tursoNameForRecord,
} from "../DatabaseRegistryService.js";
import {
  resolveAppDataSource,
  type AppDataSource,
  type AppDataSourcesFile,
} from "../appDataSources.js";
import { seedPerUserSchemaFromBase } from "../tursoPerUserSchemaSeed.js";
import type {
  AppRuntimeRouteAuth,
  DbQueryResult,
  DbSchemaSource,
  DbWriteBatchResultItem,
  DbWriteBatchStatement,
  DbWriteResult,
  TursoCredentialsProvider,
  ClientTokenScope,
} from "./types.js";
import { rewriteSqlForTurso } from "./rewriteSqlForTurso.js";
import {
  CLIENT_SCOPE_SCHEMA_SQL,
  clientDeniedError,
  deniedTableFromError,
  guessDeniedTable,
  publicTablesFromSchema,
  tokenHasTablePermissions,
  type ClientScopeMode,
} from "./clientTableScope.js";
import {
  resolveTursoActingUserIdForSource,
  resolveTursoSuffixUserIdForSource,
  type TursoDbActors,
} from "./tursoRuntimeIdentity.js";
import type { WorkspaceLogHostScope } from "../../../core/types/workspaceLog.js";
import { shouldUseTursoReplicaForDb } from "../../utils/tursoReplicaEnabled.js";
import { refreshAppDataSourcesConfig } from "./cloudDatabaseRegistry.js";
import { getServiceSecret } from "../../../core/utils/serviceSecrets.js";

/** Cloud host request: `userId` = publisher; optional session visitor for per-user DBs. */
type TursoDbActorInput = {
  userId: string;
  callerUserId?: string;
  /**
   * Set for SQL that came from the browser. The statement then runs on a
   * Turso token that lists only the database's public tables, so private
   * tables, views over them and sync tables are refused by Turso itself.
   * Omitted = host-internal call (bookkeeping, backend DB proxy) → owner token.
   */
  clientScope?: ClientScopeMode;
};

const PUBLIC_TABLES_TTL_MS = Number(process.env["CLOUD_DB_PUBLIC_TABLES_TTL_MS"] ?? 30_000);

function toLibsqlArgs(params: unknown[] | undefined): InArgs {
  return (params ?? []) as InArgs;
}

/**
 * How often (per database) the adapter re-reads _papr_sync_meta to detect
 * writes from other writers (desktop boundary-sync pushes, sandboxes).
 * Bounds micro-cache staleness for external writes to roughly this window.
 */
const SYNC_VERSION_CHECK_MS = Number(
  process.env["CLOUD_DB_VERSION_CHECK_MS"] ?? 2_500,
);

interface SyncVersionMemo {
  version: number | null;
  checkedAt: number;
}

/** Ping a little under Turso's ~5 s idle close. */
const KEEP_WARM_INTERVAL_MS = 4_000;
/** Keep a database warm this long after its last real query. */
const KEEP_WARM_WINDOW_MS = 10 * 60_000;
const KEEP_WARM_MAX_CLIENTS = 200;

export class TursoDbAdapter {
  private clientCache = new Map<string, { client: Client; tokenExpiresAt: number }>();
  /** Public-table list per database (schema read with the owner token). */
  private publicTablesCache = new Map<string, { tables: string[]; expiresAt: number }>();
  /** Last observed _papr_sync_meta version per client key. */
  private syncVersionMemo = new Map<string, SyncVersionMemo>();
  /** Remote changelog triggers installed per client key. */
  private remoteSyncReady = new Set<string>();
  /** Dedupe concurrent CDC prep for the same linked database. */
  private remoteChangeLogPrep = new Map<string, Promise<void>>();

  /** Last time each cached client ran a real query (keep-warm window). */
  private clientLastUsed = new WeakMap<Client, number>();
  /** Diagnostics for write timing: when a client was created / last used before this call / last pinged. */
  private clientCreatedAt = new WeakMap<Client, number>();
  private clientPrevUse = new WeakMap<Client, number>();
  private clientLastPing = new WeakMap<Client, number>();
  private keepWarmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly credentials: TursoCredentialsProvider) {}

  /**
   * Turso closes idle connections after ~5 s; the next query then pays a fresh
   * TLS + WebSocket handshake to the primary (~300 ms cross-country). Ping
   * clients that served a request recently so the socket stays open.
   * Needs CPU between requests (Cloud Run "CPU always allocated") to fire.
   */
  private touchClient(client: Client): Client {
    const prev = this.clientLastUsed.get(client);
    if (prev !== undefined) this.clientPrevUse.set(client, prev);
    this.clientLastUsed.set(client, Date.now());
    if (!this.keepWarmTimer && process.env.TURSO_KEEP_WARM !== "0") {
      this.keepWarmTimer = setInterval(() => this.pingWarmClients(), KEEP_WARM_INTERVAL_MS);
      this.keepWarmTimer.unref?.();
    }
    return client;
  }

  private noteClientReuse(
    client: Client,
    startedAt: number,
    perf: { clientReused?: boolean; idleMs?: number; sincePingMs?: number },
  ): void {
    const created = this.clientCreatedAt.get(client);
    const prev = this.clientPrevUse.get(client);
    const ping = this.clientLastPing.get(client);
    perf.clientReused = created === undefined || created < startedAt;
    perf.idleMs = perf.clientReused && prev !== undefined ? startedAt - prev : -1;
    perf.sincePingMs = ping !== undefined ? startedAt - ping : -1;
  }

  private pingWarmClients(): void {
    const now = Date.now();
    let pinged = 0;
    for (const { client } of this.clientCache.values()) {
      const last = this.clientLastUsed.get(client);
      if (!last || now - last > KEEP_WARM_WINDOW_MS) continue;
      if (++pinged > KEEP_WARM_MAX_CLIENTS) break;
      client
        .execute("SELECT 1")
        .then(() => this.clientLastPing.set(client, Date.now()))
        .catch(() => {});
    }
  }

  private toActors(input: TursoDbActorInput): TursoDbActors {
    return {
      publisherUserId: input.userId,
      callerUserId: input.callerUserId,
    };
  }

  private buildWorkspaceLogHostScope(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    appId: string;
  }): WorkspaceLogHostScope {
    return {
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      ownerUserId: input.userId,
      appId: input.appId,
    };
  }

  private clientKey(
    runtimeAuth: AppRuntimeRouteAuth,
    userId: string,
    database: string,
  ): string {
    return `${runtimeAuth.namespaceId}:${runtimeAuth.slug}:${userId}:${database}`;
  }

  private async resolveTursoDatabaseName(
    source: AppDataSource,
    actors: TursoDbActors,
  ): Promise<string> {
    const suffixUserId = resolveTursoSuffixUserIdForSource(source, actors);
    const registry = getDatabaseRegistryService();
    const record = registry.getRecordForSource(source);
    if (record) {
      return tursoNameForRecord(record, suffixUserId);
    }
    if (source.dbId) {
      // Fail closed: a dbId source without a registry record could be
      // per-user — falling back to a shared job/db name would silently leak
      // one user's data to everyone. Better a hard error than a quiet leak.
      throw new Error(
        `No registry record for dbId ${source.dbId} (source ${source.alias}) — ` +
          `refusing shared-name fallback; sync databases.json and retry`,
      );
    }
    if (source.jobId) {
      // Legacy job-owned source predating the registry — cannot be per-user.
      return jobTursoDatabaseName(source.jobId);
    }
    throw new Error(`Cannot resolve Turso database for source ${source.alias}`);
  }

  /** Private tables declared for this source (lower-case). */
  private privateTablesFor(source: AppDataSource): Set<string> {
    return privateTablesOf(getDatabaseRegistryService().getRecordForSource(source));
  }

  /** Drop cached public-table lists (after CREATE TABLE / schema change). */
  invalidatePublicTables(runtimeAuth: AppRuntimeRouteAuth): void {
    const prefix = `${runtimeAuth.namespaceId}:${runtimeAuth.slug}:`;
    for (const k of this.publicTablesCache.keys()) if (k.startsWith(prefix)) this.publicTablesCache.delete(k);
    for (const [k, v] of this.clientCache) {
      if (k.startsWith(prefix) && k.includes("|client:")) {
        try { v.client.close(); } catch { /* best-effort */ }
        this.clientCache.delete(k);
      }
    }
  }

  private async publicTablesForSource(
    orgId: string,
    namespaceId: string,
    actors: TursoDbActors,
    runtimeAuth: AppRuntimeRouteAuth,
    source: AppDataSource,
    database: string,
    actingUserId: string,
  ): Promise<string[]> {
    const key = `${this.clientKey(runtimeAuth, actingUserId, database)}|${[...this.privateTablesFor(source)].sort().join(",")}`;
    const hit = this.publicTablesCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.tables;
    const owner = await this.getClientForSource(orgId, namespaceId, actors, runtimeAuth, source);
    const schema = await owner.execute(CLIENT_SCOPE_SCHEMA_SQL);
    const tables = publicTablesFromSchema(
      schema.rows.map((r) => ({ ...r })) as Record<string, unknown>[],
      this.privateTablesFor(source),
    );
    if (this.publicTablesCache.size > 5_000) this.publicTablesCache.clear();
    this.publicTablesCache.set(key, { tables, expiresAt: Date.now() + PUBLIC_TABLES_TTL_MS });
    return tables;
  }

  /**
   * Client for browser SQL: a Turso token whose fine-grained permissions list
   * only public tables. Fails closed — if memory returns a token without table
   * permissions (older server), the request is refused rather than run with
   * owner rights.
   */
  private async getScopedClientForSource(
    orgId: string,
    namespaceId: string,
    actors: TursoDbActors,
    runtimeAuth: AppRuntimeRouteAuth,
    source: AppDataSource,
    mode: ClientScopeMode,
  ): Promise<Client> {
    const actingUserId = resolveTursoActingUserIdForSource(source, actors);
    const database = await this.resolveTursoDatabaseName(source, actors);
    const tables = await this.publicTablesForSource(
      orgId, namespaceId, actors, runtimeAuth, source, database, actingUserId,
    );
    const scope: ClientTokenScope = { tables, mode };
    const cacheKey = `${this.clientKey(runtimeAuth, actingUserId, database)}|client:${mode}:${tables.join(",")}`;
    const now = Date.now();
    const cached = this.clientCache.get(cacheKey);
    if (cached && cached.tokenExpiresAt > now) return this.touchClient(cached.client);
    if (cached) {
      try { cached.client.close(); } catch { /* best-effort */ }
      this.clientCache.delete(cacheKey);
    }
    const bundle = await this.credentials.getUserDatabaseToken(
      orgId, namespaceId, actingUserId, runtimeAuth, database, scope,
    );
    if (!tokenHasTablePermissions(bundle.authToken)) {
      throw Object.assign(
        new Error("Table-scoped database access is unavailable (server not updated); refusing browser SQL with owner rights."),
        { status: 503 },
      );
    }
    const client = createClient({ url: bundle.tursoUrl, authToken: bundle.authToken });
    this.clientCreatedAt.set(client, Date.now());
    const tokenExpiresAt = bundle.expiresAt
      ? Math.max(now + 60_000, new Date(bundle.expiresAt).getTime() - 60_000)
      : now + 50 * 60 * 1000;
    this.clientCache.set(cacheKey, { client, tokenExpiresAt });
    return this.touchClient(client);
  }

  /** Owner client, or the table-scoped client when the SQL came from the browser. */
  private async clientFor(
    input: TursoDbActorInput & { orgId: string; namespaceId: string; runtimeAuth: AppRuntimeRouteAuth },
    actors: TursoDbActors,
    source: AppDataSource,
  ): Promise<Client> {
    return input.clientScope
      ? this.getScopedClientForSource(input.orgId, input.namespaceId, actors, input.runtimeAuth, source, input.clientScope)
      : this.getClientForSource(input.orgId, input.namespaceId, actors, input.runtimeAuth, source);
  }

  /**
   * Legacy sources apply writes through memory's workspace log (owner rights),
   * so browser SQL is first planned with the table-scoped token: Turso checks
   * permissions on EXPLAIN without running it. Refused → 403, nothing appended.
   */
  private async preflightScoped(
    input: TursoDbActorInput & { orgId: string; namespaceId: string; runtimeAuth: AppRuntimeRouteAuth },
    actors: TursoDbActors,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
    perf?: { clientReused?: boolean; idleMs?: number; sincePingMs?: number },
  ): Promise<void> {
    if (!input.clientScope) return;
    const startedAt = Date.now();
    const client = await this.clientFor(input, actors, source);
    if (perf) this.noteClientReuse(client, startedAt, perf);
    await client
      .execute({ sql: `EXPLAIN ${sql}`, args: toLibsqlArgs(params) })
      .catch((err: unknown) => this.rethrowClientDenied(err, input, source, sql));
  }

  /** Turn a Turso SQLITE_AUTH refusal on browser SQL into a plain 403. */
  private rethrowClientDenied(err: unknown, input: TursoDbActorInput, source: AppDataSource, sql?: string): never {
    if (input.clientScope) {
      const { denied, table } = deniedTableFromError(err);
      if (denied) {
        const priv = this.privateTablesFor(source);
        throw clientDeniedError(table ?? (sql ? guessDeniedTable(sql, priv) : undefined), priv, input.clientScope);
      }
    }
    throw err;
  }

  private async getClientForSource(
    orgId: string,
    namespaceId: string,
    actors: TursoDbActors,
    runtimeAuth: AppRuntimeRouteAuth,
    source: AppDataSource,
  ): Promise<Client> {
    const actingUserId = resolveTursoActingUserIdForSource(source, actors);
    const database = await this.resolveTursoDatabaseName(source, actors);
    const cacheKey = this.clientKey(runtimeAuth, actingUserId, database);
    const cached = this.clientCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.tokenExpiresAt > now) {
      return this.touchClient(cached.client);
    }
    if (cached) {
      try {
        cached.client.close();
      } catch {
        /* best-effort */
      }
      this.clientCache.delete(cacheKey);
    }

    const fetchToken = async (): Promise<{
      tursoUrl: string;
      authToken: string;
      expiresAt?: string;
    }> =>
      this.credentials.getUserDatabaseToken(
        orgId,
        namespaceId,
        actingUserId,
        runtimeAuth,
        database,
      );

    let tokenBundle: { tursoUrl: string; authToken: string; expiresAt?: string };
    try {
      tokenBundle = await fetchToken();
    } catch (error) {
      const message = (error as Error).message;
      const isDbTokenDenied =
        message.includes("403") && message.includes("not linked");
      if (isDbTokenDenied && source.dbId) {
        await refreshAppDataSourcesConfig(runtimeAuth);
        tokenBundle = await fetchToken();
      } else {
        throw error;
      }
    }

    const { tursoUrl, authToken, expiresAt } = tokenBundle;
    const client = createClient({ url: tursoUrl, authToken });
    this.clientCreatedAt.set(client, Date.now());
    const tokenExpiresAt = expiresAt
      ? Math.max(now + 60_000, new Date(expiresAt).getTime() - 60_000)
      : now + 50 * 60 * 1000;
    this.clientCache.set(cacheKey, { client, tokenExpiresAt });
    this.touchClient(client);

    const registry = getDatabaseRegistryService();
    const record = registry.getRecordForSource(source);
    if (record?.isolation === "per-user") {
      const baseName = tursoNameForRecord(record);
      if (baseName !== database) {
        try {
          const baseCreds = await this.credentials.getUserDatabaseToken(
            orgId,
            namespaceId,
            actingUserId,
            runtimeAuth,
            baseName,
          );
          const baseClient = createClient({
            url: baseCreds.tursoUrl,
            authToken: baseCreds.authToken,
          });
          try {
            await seedPerUserSchemaFromBase(client, baseClient);
          } finally {
            baseClient.close();
          }
        } catch (err) {
          // Expected for visitors: only the publisher can open the base database.
          // The memory server seeds a new per-user copy with the base schema when
          // it issues the token, so this client-side copy is only a fallback.
          console.warn(
            `[TursoDbAdapter] per-user schema seed from ${baseName} skipped: ${(err as Error).message?.slice(0, 160)}`,
          );
        }
      }
    }

    return client;
  }

  /** Sync-version bump with the owner client (the meta table is never on a client token). */
  private async bumpOwnerSyncVersion(
    input: TursoDbActorInput & { orgId: string; namespaceId: string; runtimeAuth: AppRuntimeRouteAuth },
    actors: TursoDbActors,
    source: AppDataSource,
    cacheKey: string,
  ): Promise<void> {
    try {
      const owner = await this.getClientForSource(input.orgId, input.namespaceId, actors, input.runtimeAuth, source);
      await this.bumpSyncVersionSafe(owner, cacheKey);
    } catch {
      /* best-effort — same as bumpSyncVersionSafe */
    }
  }

  /**
   * Best-effort bump of the remote sync version after a host-side write so
   * desktop version-checked pulls see the change. Never fails the write.
   */
  private async bumpSyncVersionSafe(client: Client, key: string): Promise<void> {
    try {
      const version = await bumpRemoteSyncVersion(client);
      this.syncVersionMemo.set(key, {
        version: version ?? null,
        checkedAt: Date.now(),
      });
    } catch {
      // Best-effort — a failed bump only delays other devices' pulls until
      // the next successful push bumps the counter.
    }
  }

  /**
   * Plan A replica databases sync through Turso Sync, not the legacy
   * `_papr_sync_log` CDC path. Installing legacy triggers on their primary
   * ALTERs every user table (adds `_papr_created_at` / `_papr_updated_at` /
   * `_papr_row_version`), the columns replicate down to every desktop, and
   * any positional `INSERT INTO t VALUES (...)` against that table starts
   * failing ("table t has 17 columns but 14 values"). The triggers also log
   * every write into `_papr_sync_log`, which nothing on the replica path reads
   * or prunes.
   */
  private isReplicaModeSource(source: AppDataSource | undefined): boolean {
    if (!source) {
      return false;
    }
    const record = getDatabaseRegistryService().getRecordForSource(source);
    if (record?.syncMode === "replica") {
      return true;
    }
    return shouldUseTursoReplicaForDb({ syncMode: record?.syncMode });
  }

  /** Install remote CDC triggers so cloud mini-app writes appear in _papr_sync_log. */
  private async ensureRemoteChangeLogReady(
    client: Client,
    cacheKey: string,
    schemaRevision: string | null = null,
    source?: AppDataSource,
  ): Promise<void> {
    if (this.remoteSyncReady.has(cacheKey)) {
      return;
    }
    if (this.isReplicaModeSource(source)) {
      // Keep _papr_sync_meta (hasRemoteChanged / bumpSyncVersion use it);
      // skip the per-table columns + triggers.
      await ensureRemoteSyncInfrastructure(client);
      this.remoteSyncReady.add(cacheKey);
      return;
    }
    const inflight = this.remoteChangeLogPrep.get(cacheKey);
    if (inflight) {
      await inflight;
      return;
    }

    const prep = this.runEnsureRemoteChangeLogReady(client, cacheKey, schemaRevision);
    this.remoteChangeLogPrep.set(cacheKey, prep);
    try {
      await prep;
    } finally {
      if (this.remoteChangeLogPrep.get(cacheKey) === prep) {
        this.remoteChangeLogPrep.delete(cacheKey);
      }
    }
  }

  private async runEnsureRemoteChangeLogReady(
    client: Client,
    cacheKey: string,
    schemaRevision: string | null,
  ): Promise<void> {
    if (this.remoteSyncReady.has(cacheKey)) {
      return;
    }
    const startedMs = performance.now();
    await ensureRemoteSyncInfrastructure(client);
    const tableNames = await this.listRemoteTables(client);
    const syncableCount = filterSyncableTables(tableNames).length;
    const revisionKey = schemaRevision?.trim() || "unknown";

    const triggersReady = await remoteInsertTriggersCoverSyncableTables(
      client,
      tableNames,
    );
    if (triggersReady) {
      this.remoteSyncReady.add(cacheKey);
      writeRemoteCdcReadyMarker(cacheKey, revisionKey, {
        tableCount: syncableCount,
        recordedAtMs: Date.now(),
      });
      if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
        console.log(
          `[TursoDbAdapter] remote CDC ready (fast path) key=${cacheKey} ` +
            `tables=${syncableCount} warmCdcMs=${Math.round(performance.now() - startedMs)}`,
        );
      }
      return;
    }

    for (const tableName of tableNames) {
      const cols = await client.execute(
        `PRAGMA table_info(${quoteIdent(tableName)})`,
      );
      const columns = cols.rows.map((row) => ({
        name: String(row.name ?? ""),
        type: String(row.type ?? "TEXT"),
        primaryKey: Number(row.pk ?? 0) > 0,
      }));
      await ensureRemoteTableSyncTriggers(client, columns, tableName);
    }
    this.remoteSyncReady.add(cacheKey);
    writeRemoteCdcReadyMarker(cacheKey, revisionKey, {
      tableCount: syncableCount,
      recordedAtMs: Date.now(),
    });
    if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
      console.log(
        `[TursoDbAdapter] remote CDC ready (full prep) key=${cacheKey} ` +
          `tables=${syncableCount} warmCdcMs=${Math.round(performance.now() - startedMs)}`,
      );
    }
  }

  /**
   * True when another writer (e.g. a desktop boundary-sync push) has bumped
   * _papr_sync_meta since we last looked. Memoized per database for
   * SYNC_VERSION_CHECK_MS so cache-hit paths stay cheap (at most one
   * single-row read per window). Fail-open: errors report "unchanged".
   */
  async hasRemoteChanged(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    sourceId?: string;
  }): Promise<boolean> {
    try {
      const actors = this.toActors(input);
      const source = await resolveAppDataSource(input.config, {
        sourceId: input.sourceId,
        operation: "read",
      });
      if (!source) return false;
      const actingUserId = resolveTursoActingUserIdForSource(source, actors);
      const database = await this.resolveTursoDatabaseName(source, actors);
      const key = this.clientKey(input.runtimeAuth, actingUserId, database);
      const memo = this.syncVersionMemo.get(key);
      const now = Date.now();
      if (memo && now - memo.checkedAt < SYNC_VERSION_CHECK_MS) return false;

      const client = await this.getClientForSource(
        input.orgId,
        input.namespaceId,
        actors,
        input.runtimeAuth,
        source,
      );
      const version = await readRemoteSyncVersion(client);
      this.syncVersionMemo.set(key, { version, checkedAt: now });
      if (!memo) return false; // first observation — nothing to compare against
      return version !== memo.version;
    } catch {
      return false; // fail-open: serve cached rather than error or hammer Turso
    }
  }

  private async listRemoteTables(client: Client): Promise<string[]> {
    const result = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      args: [],
    });
    return filterSyncableTables(
      result.rows.map((row) => String(row.name ?? "")),
    );
  }

  /**
   * Resolve linked source + SQL rewrite from in-memory config only.
   * Does not open Turso — callers fetch the client when they need to execute.
   * (rewriteSqlForTurso is identity today; remote table introspection was ~1 RTT/op.)
   */
  async resolveSource(
    config: AppDataSourcesFile,
    options: {
      sourceId?: string;
      sql?: string;
      operation: "read" | "write";
      orgId: string;
      namespaceId: string;
      actors: TursoDbActors;
      runtimeAuth: AppRuntimeRouteAuth;
    },
  ): Promise<{ source: AppDataSource; remoteSql: string; localTables: string[] }> {
    void options.orgId;
    void options.namespaceId;
    void options.actors;
    void options.runtimeAuth;

    const source = await resolveAppDataSource(config, {
      sourceId: options.sourceId,
      sql: options.sql,
      operation: options.operation,
    });

    const syncable = filterSyncableTables(source.tables);
    const remoteSql = options.sql
      ? rewriteSqlForTurso(options.sql, source, syncable)
      : "";

    return { source, remoteSql, localTables: syncable };
  }

  async query(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    sourceId?: string;
    sql: string;
    params?: unknown[];
  }): Promise<DbQueryResult> {
    const actors = this.toActors(input);
    const { source, remoteSql } = await this.resolveSource(input.config, {
      sourceId: input.sourceId,
      sql: input.sql,
      operation: "read",
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      actors,
      runtimeAuth: input.runtimeAuth,
    });

    const client = await this.clientFor(input, actors, source);
    // Row cap: outer LIMIT keeps a single unbounded SELECT from billing
    // an entire large table's rows on Turso.
    const result = await client
      .execute({ sql: capReadSql(remoteSql), args: toLibsqlArgs(input.params) })
      .catch((err: unknown) => this.rethrowClientDenied(err, input, source, remoteSql));
    const allRows = result.rows.map((row) => ({ ...row })) as Record<string, unknown>[];
    const { rows, truncated } = capRows(allRows, MAX_READ_ROWS);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    return {
      rows,
      columns,
      count: rows.length,
      source: source.alias,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  async write(input: TursoDbActorInput & {
    /** Optional per-step timings (ms) for Server-Timing; filled on the Turso path. */
    perf?: {
      clientMs?: number;
      execMs?: number;
      bumpMs?: number;
      /** false = a new libsql client (fresh socket) was created for this write. */
      clientReused?: boolean;
      /** ms since this client last served a request (-1 = never). */
      idleMs?: number;
      /** ms since keep-warm last pinged this client (-1 = never). */
      sincePingMs?: number;
      /** Workspace-log path: scoped EXPLAIN preflight and memory append (ms). */
      preflightMs?: number;
      appendMs?: number;
    };
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    appId: string;
    sourceId?: string;
    sql: string;
    params?: unknown[];
  }): Promise<DbWriteResult> {
    const actors = this.toActors(input);
    const { source, remoteSql } = await this.resolveSource(input.config, {
      sourceId: input.sourceId,
      sql: input.sql,
      operation: "write",
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      actors,
      runtimeAuth: input.runtimeAuth,
    });

    const database = await this.resolveTursoDatabaseName(source, actors);
    const actingUserId = resolveTursoActingUserIdForSource(source, actors);
    const cacheKey = this.clientKey(input.runtimeAuth, actingUserId, database);

    if (this.usesWorkspaceLogAuthorityForSource(source)) {
      const preflightStarted = performance.now();
      await this.preflightScoped(input, actors, source, remoteSql, input.params, input.perf);
      if (input.perf) input.perf.preflightMs = performance.now() - preflightStarted;
      const appendStarted = performance.now();
      const { appendRuntimeWorkspaceLogEntry } = await import(
        "./memoryRuntimeClient.js"
      );
      const hostScope = this.buildWorkspaceLogHostScope(input);
      const appendResult = await appendRuntimeWorkspaceLogEntry(
        input.runtimeAuth,
        {
          replicaId: database,
          kind: "row",
          dbSourceId: source.alias ?? source.jobId,
          payload: {
            appId: input.appId,
            sql: remoteSql,
            params: input.params,
          },
        },
        hostScope,
      );
      this.syncVersionMemo.delete(cacheKey);
      if (input.perf) input.perf.appendMs = performance.now() - appendStarted;

      if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
        console.log(
          `[TursoDbAdapter] write app=${input.appId} source=${source.alias} ` +
            `memoryLatencyMs=${appendResult.latencyMs} ` +
            `changes=${appendResult.changes ?? 1}`,
        );
      }

      return {
        changes: appendResult.changes ?? 1,
        lastInsertRowid: appendResult.lastInsertRowid ?? 0,
        source: source.alias,
      };
    }

    const clientStarted = performance.now();
    const clientStartedAt = Date.now();
    const client = await this.clientFor(input, actors, source);
    if (input.perf) this.noteClientReuse(client, clientStartedAt, input.perf);

    if (!input.clientScope) await this.ensureRemoteChangeLogReady(client, cacheKey, null, source);
    const execStarted = performance.now();
    const result = await client
      .execute({ sql: remoteSql, args: toLibsqlArgs(input.params) })
      .catch((err: unknown) => this.rethrowClientDenied(err, input, source, remoteSql));

    // Bump _papr_sync_meta so desktop version-checked pulls (and other host
    // instances' version-gated caches) see this write. Runs after the write
    // commits (a pull that sees the new version must also see the row). It
    // uses the owner client — the browser's table-scoped token cannot touch
    // the meta table — so it cannot share the write's batch.
    const bumpStarted = performance.now();
    await this.bumpOwnerSyncVersion(input, actors, source, cacheKey);
    if (input.perf) {
      input.perf.clientMs = execStarted - clientStarted;
      input.perf.execMs = bumpStarted - execStarted;
      input.perf.bumpMs = performance.now() - bumpStarted;
    }

    return {
      changes: result.rowsAffected,
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      source: source.alias,
    };
  }

  /** Max row writes per interactive batch (matches read batch cap). */
  static readonly MAX_WRITE_BATCH = 25;

  async writeBatch(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    appId: string;
    statements: DbWriteBatchStatement[];
    atomic?: boolean;
  }): Promise<{ results: DbWriteBatchResultItem[] }> {
    const atomic = input.atomic === true;
    const actors = this.toActors(input);
    if (input.statements.length === 0) {
      throw new Error("Batch must include at least one statement");
    }
    if (input.statements.length > TursoDbAdapter.MAX_WRITE_BATCH) {
      throw new Error(
        `Batch limited to ${TursoDbAdapter.MAX_WRITE_BATCH} statements`,
      );
    }

    type ResolvedStmt = {
      index: number;
      source: AppDataSource;
      remoteSql: string;
      params?: unknown[];
      database: string;
    };

    const resolved: ResolvedStmt[] = [];
    for (let index = 0; index < input.statements.length; index++) {
      const stmt = input.statements[index];
      const { source, remoteSql } = await this.resolveSource(input.config, {
        sourceId: stmt.sourceId,
        sql: stmt.sql,
        operation: "write",
        orgId: input.orgId,
        namespaceId: input.namespaceId,
        actors,
        runtimeAuth: input.runtimeAuth,
      });
      const database = await this.resolveTursoDatabaseName(source, actors);
      resolved.push({
        index,
        source,
        remoteSql,
        params: stmt.params,
        database,
      });
    }

    const results: DbWriteBatchResultItem[] = new Array(input.statements.length);

    if (atomic) {
      const databases = new Set(resolved.map((item) => item.database));
      if (databases.size > 1) {
        throw Object.assign(
          new Error(
            "atomic write-batch requires all statements on the same linked database (sourceId).",
          ),
          { status: 400 },
        );
      }

      const group = resolved;
      const database = group[0].database;
      const actingUserId = resolveTursoActingUserIdForSource(group[0].source, actors);
      const cacheKey = this.clientKey(input.runtimeAuth, actingUserId, database);

      if (this.usesWorkspaceLogAuthorityForSource(group[0].source)) {
        for (const item of group) {
          await this.preflightScoped(input, actors, item.source, item.remoteSql, item.params);
        }
        const { appendRuntimeWorkspaceLogBatch } = await import(
          "./memoryRuntimeClient.js"
        );
        const hostScope = this.buildWorkspaceLogHostScope(input);
        try {
          const batchResult = await appendRuntimeWorkspaceLogBatch(
            input.runtimeAuth,
            {
              replicaId: database,
              entries: group.map((item) => ({
                kind: "row" as const,
                dbSourceId: item.source.alias ?? item.source.jobId,
                payload: {
                  appId: input.appId,
                  sql: item.remoteSql,
                  params: item.params,
                },
              })),
            },
            hostScope,
          );
          this.syncVersionMemo.delete(cacheKey);
          for (const item of group) {
            results[item.index] = {
              ok: true,
              changes: 1,
              lastInsertRowid: 0,
              source: item.source.alias,
            };
          }
          if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
            console.log(
              `[TursoDbAdapter] atomic writeBatch app=${input.appId} replica=${database} ` +
                `count=${batchResult.count} memoryLatencyMs=${batchResult.latencyMs}`,
            );
          }
        } catch (err) {
          const message = (err as Error).message;
          for (const item of group) {
            results[item.index] = {
              ok: false,
              changes: 0,
              lastInsertRowid: 0,
              source: item.source.alias,
              error: message,
            };
          }
        }
        return { results };
      }

      try {
        const client = await this.clientFor(input, actors, group[0].source);
        if (!input.clientScope) {
          await this.ensureRemoteChangeLogReady(client, cacheKey, null, group[0].source);
        }
        const batchResults = await client
          .batch(group.map((item) => ({ sql: item.remoteSql, args: toLibsqlArgs(item.params) })))
          .catch((err: unknown) =>
            this.rethrowClientDenied(err, input, group[0].source, group.map((g) => g.remoteSql).join("\n")),
          );
        await this.bumpOwnerSyncVersion(input, actors, group[0].source, cacheKey);
        for (let i = 0; i < group.length; i++) {
          const item = group[i];
          const row = batchResults[i];
          results[item.index] = {
            ok: true,
            changes: row.rowsAffected,
            lastInsertRowid: Number(row.lastInsertRowid ?? 0),
            source: item.source.alias,
          };
        }
      } catch (err) {
        const message = (err as Error).message;
        for (const item of group) {
          results[item.index] = {
            ok: false,
            changes: 0,
            lastInsertRowid: 0,
            source: item.source.alias,
            error: message,
          };
        }
      }
      return { results };
    }

    const allLegacyWorkspaceLog = resolved.every((item) =>
      this.usesWorkspaceLogAuthorityForSource(item.source),
    );
    if (allLegacyWorkspaceLog) {
      for (const item of resolved) {
        await this.preflightScoped(input, actors, item.source, item.remoteSql, item.params);
      }
      const groups = new Map<string, ResolvedStmt[]>();
      for (const item of resolved) {
        const group = groups.get(item.database) ?? [];
        group.push(item);
        groups.set(item.database, group);
      }

      const { appendRuntimeWorkspaceLogBatch } = await import(
        "./memoryRuntimeClient.js"
      );
      const hostScope = this.buildWorkspaceLogHostScope(input);

      for (const [database, group] of groups) {
        const actingUserId = resolveTursoActingUserIdForSource(
          group[0].source,
          actors,
        );
        const cacheKey = this.clientKey(
          input.runtimeAuth,
          actingUserId,
          database,
        );
        try {
          const batchResult = await appendRuntimeWorkspaceLogBatch(
            input.runtimeAuth,
            {
              replicaId: database,
              entries: group.map((item) => ({
                kind: "row" as const,
                dbSourceId: item.source.alias ?? item.source.jobId,
                payload: {
                  appId: input.appId,
                  sql: item.remoteSql,
                  params: item.params,
                },
              })),
            },
            hostScope,
          );
          this.syncVersionMemo.delete(cacheKey);

          if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
            console.log(
              `[TursoDbAdapter] writeBatch app=${input.appId} replica=${database} ` +
                `count=${batchResult.count} memoryLatencyMs=${batchResult.latencyMs}`,
            );
          }

          for (const item of group) {
            results[item.index] = {
              ok: true,
              changes: 1,
              lastInsertRowid: 0,
              source: item.source.alias,
            };
          }
        } catch (err) {
          const message = (err as Error).message;
          for (const item of group) {
            results[item.index] = {
              ok: false,
              changes: 0,
              lastInsertRowid: 0,
              source: item.source.alias,
              error: message,
            };
          }
        }
      }

      return { results };
    }

    for (const item of resolved) {
      try {
        const writeResult = await this.write({
          orgId: input.orgId,
          namespaceId: input.namespaceId,
          userId: input.userId,
          callerUserId: input.callerUserId,
          clientScope: input.clientScope,
          runtimeAuth: input.runtimeAuth,
          config: input.config,
          appId: input.appId,
          sourceId: input.statements[item.index].sourceId,
          sql: input.statements[item.index].sql,
          params: item.params,
        });
        results[item.index] = { ok: true, ...writeResult };
      } catch (err) {
        results[item.index] = {
          ok: false,
          changes: 0,
          lastInsertRowid: 0,
          source: item.source.alias,
          error: (err as Error).message,
        };
      }
    }

    return { results };
  }

  async exec(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    appId: string;
    sourceId?: string;
    sql: string;
  }): Promise<{ ok: true; source: string }> {
    const actors = this.toActors(input);
    const { source } = await this.resolveSource(input.config, {
      sourceId: input.sourceId,
      sql: input.sql,
      operation: "write",
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      actors,
      runtimeAuth: input.runtimeAuth,
    });

    const client = await this.clientFor(input, actors, source);
    const database = await this.resolveTursoDatabaseName(source, actors);
    const actingUserId = resolveTursoActingUserIdForSource(source, actors);
    const cacheKey = this.clientKey(input.runtimeAuth, actingUserId, database);

    if (this.usesWorkspaceLogAuthorityForSource(source)) {
      await this.preflightScoped(input, actors, source, input.sql);
      const { appendRuntimeWorkspaceLogEntry } = await import(
        "./memoryRuntimeClient.js"
      );
      const hostScope = this.buildWorkspaceLogHostScope(input);
      await appendRuntimeWorkspaceLogEntry(
        input.runtimeAuth,
        {
          replicaId: database,
          kind: "schema",
          dbSourceId: source.alias ?? source.jobId,
          payload: {
            appId: input.appId,
            sql: input.sql,
          },
        },
        hostScope,
      );
      this.syncVersionMemo.delete(cacheKey);
      return { ok: true, source: source.alias };
    }

    if (!input.clientScope) await this.ensureRemoteChangeLogReady(client, cacheKey, null, source);
    await client.execute(input.sql).catch((err: unknown) => this.rethrowClientDenied(err, input, source, input.sql));
    this.invalidatePublicTables(input.runtimeAuth);
    await this.bumpOwnerSyncVersion(input, actors, source, cacheKey);
    return { ok: true, source: source.alias };
  }

  /** Legacy linked sources use workspace log; replica-mode sources use Turso direct. */
  private usesWorkspaceLogAuthorityForSource(source: AppDataSource): boolean {
    if (!getServiceSecret("PAPR_CLOUD_APP_HOST_KEY")) {
      return false;
    }
    const registry = getDatabaseRegistryService();
    const record = registry.getRecordForSource(source);
    return !shouldUseTursoReplicaForDb({ syncMode: record?.syncMode });
  }

  async schema(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
  }): Promise<DbSchemaSource[]> {
    const actors = this.toActors(input);
    return Promise.all(
      input.config.sources.map(async (source) => {
        try {
          const client = await this.getClientForSource(
            input.orgId,
            input.namespaceId,
            actors,
            input.runtimeAuth,
            source,
          );
          const tablesResult = await client.execute({
            sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
            args: [],
          });

          const tables = await Promise.all(
            filterSyncableTables(
              tablesResult.rows.map((row) => String(row.name ?? "")),
            ).map(async (localName) => {
              const cols = await client.execute(
                `PRAGMA table_info(${quoteIdent(localName)})`,
              );
              return {
                table: localName,
                columns: cols.rows.map((c) => ({
                  name: String(c.name ?? ""),
                  type: String(c.type ?? ""),
                  pk: Number(c.pk ?? 0) === 1,
                })),
              };
            }),
          );

          return {
            sourceId: source.id,
            alias: source.alias,
            tables,
          };
        } catch (err) {
          return {
            sourceId: source.id,
            alias: source.alias,
            tables: [],
            error: (err as Error).message,
          };
        }
      }),
    );
  }

  /** Highest applied migration id across all linked sources (for schema gate). */
  async getMaxAppliedMigrationId(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
  }): Promise<string | null> {
    const actors = this.toActors(input);
    let maxId: string | null = null;

    for (const source of input.config.sources) {
      try {
        const client = await this.getClientForSource(
          input.orgId,
          input.namespaceId,
          actors,
          input.runtimeAuth,
          source,
        );
        const result = await client.execute(
          "SELECT id FROM schema_migrations ORDER BY id",
        );
        for (const row of result.rows) {
          const id = String(row.id ?? "");
          if (!id || shouldSkipMigrationForRemoteLedger(id)) {
            continue;
          }
          if (!maxId || id > maxId) {
            maxId = id;
          }
        }
      } catch {
        /* skip source */
      }
    }

    return maxId;
  }

  /**
   * Best-effort prefetch of Turso db-token + libsql clients for linked sources.
   * Called async on app open so first read/write avoids cold-token latency.
   */
  async warmLinkedSources(input: TursoDbActorInput & {
    orgId: string;
    namespaceId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    /** When true, also prepare remote CDC triggers (replica direct-write path). */
    warmRemoteChangeLog?: boolean;
  }): Promise<void> {
    const actors = this.toActors(input);
    let schemaRevision: string | null = null;
    if (input.warmRemoteChangeLog) {
      schemaRevision = await this.getMaxAppliedMigrationId(input);
    }

    for (const source of input.config.sources) {
      if (!source.jobId && !source.dbId) {
        continue;
      }
      try {
        const client = await this.getClientForSource(
          input.orgId,
          input.namespaceId,
          actors,
          input.runtimeAuth,
          source,
        );
        if (!input.warmRemoteChangeLog) {
          continue;
        }
        if (this.usesWorkspaceLogAuthorityForSource(source)) {
          continue;
        }
        const actingUserId = resolveTursoActingUserIdForSource(source, actors);
        const database = await this.resolveTursoDatabaseName(source, actors);
        const cacheKey = this.clientKey(
          input.runtimeAuth,
          actingUserId,
          database,
        );
        await this.ensureRemoteChangeLogReady(client, cacheKey, schemaRevision, source);
      } catch {
        /* best-effort warm */
      }
    }
  }
}

export { jobTursoDatabaseName };
