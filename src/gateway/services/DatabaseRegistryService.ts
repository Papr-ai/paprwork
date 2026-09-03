/**
 * Independent database registry — ~/Papr/data/databases.json
 *
 * Databases are first-class resources; apps/jobs attach via data-sources.json.
 * Turso short names: legacy j-{jobId8} or d-{dbId8} for standalone DBs.
 */

import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir, getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  canPerformWorkspaceWrite,
  getWorkspaceWriteGeneration,
} from "./workspaceWriteGuard.js";
import {
  dbTursoDatabaseName,
  jobTursoDatabaseName,
  resolveTursoShortName,
} from "./tursoDatabaseNaming.js";
import {
  parseDataSourcesFile,
  type AppDataSource,
} from "./appDataSources.js";
import type { DatabaseSyncMode } from "./tursoReplica/tursoReplicaTypes.js";
import { defaultSyncModeForNewRegistryDb } from "../utils/tursoReplicaEnabled.js";

export const DATABASES_REGISTRY_FILENAME = "databases.json";

export type DatabaseIsolation = "shared" | "per-user";
export type DatabaseStatus = "active" | "tombstone";

export interface DatabaseRecord {
  dbId: string;
  localPath: string;
  tursoShortName: string;
  label?: string;
  ownerJobId?: string;
  /** App whose repo ships migrations/ for this dbId (one owner per shared db). */
  schemaOwnerAppId?: string;
  isolation: DatabaseIsolation;
  status: DatabaseStatus;
  /** legacy = CDC/log path; replica = Turso Sync (@tursodatabase/sync). */
  syncMode?: DatabaseSyncMode;
  cutoverAt?: string;
  /** True while cutover is running — cleared on success or rollback (crash resume). */
  cutoverInProgress?: boolean;
  cutoverStartedAt?: string;
  cutoverBlocked?: boolean;
  cutoverBlockReason?: string;
  lastReplicaPushError?: string;
  /** ISO timestamp of last successful replica push (Plan A phantom CDC guard). */
  lastReplicaPushAt?: string;
  /** ISO timestamp of last local replica mutation (DML/DDL/migration). */
  lastReplicaLocalMutationAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseRegistrySaveOptions {
  /** Local-only bookkeeping (replica push timestamps) — skip memory server upload. */
  skipCloudUpload?: boolean;
}

export interface DatabasesRegistryFile {
  version: 1;
  databases: Record<string, DatabaseRecord>;
}

function defaultRegistry(): DatabasesRegistryFile {
  return { version: 1, databases: {} };
}

export function normalizeDbPath(dbPath: string): string {
  return path.normalize(dbPath);
}

/** Slug segment from a registry db path (`data/databases/{slug}/data.db`). */
export function registrySlugFromLocalPath(localPath: string): string | null {
  const normalized = localPath.replace(/\\/g, "/");
  const match = normalized.match(/\/data\/databases\/([^/]+)\/data\.db$/);
  return match?.[1] ?? null;
}

export function dbIdFromPath(dbPath: string): string {
  const hash = createHash("sha256")
    .update(normalizeDbPath(dbPath))
    .digest("hex")
    .slice(0, 8);
  return `db-${hash}`;
}

export function newDbId(): string {
  return `db-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function tursoNameForRecord(
  record: Pick<
    DatabaseRecord,
    "dbId" | "tursoShortName" | "ownerJobId" | "isolation"
  >,
  userId?: string,
): string {
  return resolveTursoShortName(
    {
      dbId: record.dbId,
      tursoShortName: record.tursoShortName,
      ownerJobId: record.ownerJobId,
      isolation: record.isolation,
    },
    userId,
  );
}

/** Resolve Turso short name for a linked data source (registry → jobId fallback). */
export function resolveTursoDatabaseNameForSource(
  source: AppDataSource,
  userId?: string,
): string | null {
  const registry = getDatabaseRegistryService();
  if (source.dbId) {
    const record = registry.getById(source.dbId);
    if (record) {
      return tursoNameForRecord(record, userId);
    }
    return dbTursoDatabaseName(source.dbId);
  }
  const byPath = registry.getByPath(source.dbPath);
  if (byPath) {
    return tursoNameForRecord(byPath, userId);
  }
  if (source.jobId) {
    return jobTursoDatabaseName(source.jobId);
  }
  return null;
}

let registryInstance: DatabaseRegistryService | null = null;

export class DatabaseRegistryService {
  private registryPath: string;
  private appsRootDir: string;
  private cache: DatabasesRegistryFile | null = null;
  private saveLock: Promise<void> | null = null;
  private boundPaprDir: string | null = null;
  private boundWriteGeneration: number | null = null;

  constructor(paprDataDir?: string, appsRootDir?: string) {
    const dataDir = paprDataDir ?? getPaprDataDir();
    this.registryPath = path.join(dataDir, DATABASES_REGISTRY_FILENAME);
    this.appsRootDir =
      appsRootDir ?? path.join(path.dirname(dataDir), "apps");
  }

  async initialize(): Promise<void> {
    this.bindWorkspaceWriteContext();
    this.cache = await this.load();
    await this.backfillFromAppsIfNeeded();
  }

  private bindWorkspaceWriteContext(): void {
    this.boundPaprDir = getPaprRoot();
    this.boundWriteGeneration = getWorkspaceWriteGeneration();
  }

  private isWriteContextValid(context: string): boolean {
    if (this.boundPaprDir === null || this.boundWriteGeneration === null) {
      return true;
    }
    return canPerformWorkspaceWrite(
      this.boundWriteGeneration,
      this.boundPaprDir,
      context,
    );
  }

  getRegistryPath(): string {
    return this.registryPath;
  }

  private async load(): Promise<DatabasesRegistryFile> {
    try {
      const raw = await fs.promises.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as DatabasesRegistryFile;
      if (parsed?.databases && typeof parsed.databases === "object") {
        return parsed;
      }
    } catch {
      /* first run */
    }
    return defaultRegistry();
  }

  private async save(
    state: DatabasesRegistryFile,
    options?: DatabaseRegistrySaveOptions,
  ): Promise<void> {
    if (!this.isWriteContextValid("databases.json save")) {
      return;
    }
    // Chain onto whatever is in flight instead of `if (lock) await lock`.
    // Two callers arriving while saveLock was null both skipped the await and
    // both assigned, so they ran concurrently — and with a tmp name built only
    // from pid+ms they collided on the SAME file. The loser's rename then hit
    // "ENOENT: rename databases.json.tmp-... -> databases.json", which is what
    // crashed sequence editing (delete step + add step + change delay fire
    // several /api/db/write calls in the same millisecond).
    const previous = this.saveLock ?? Promise.resolve();

    this.saveLock = (async () => {
      await previous.catch(() => {});
      // Random suffix: pid+ms is not unique within a single process tick.
      const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmpPath = `${this.registryPath}.tmp-${unique}`;
      await fs.promises.mkdir(path.dirname(this.registryPath), {
        recursive: true,
      });
      await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
      await fs.promises.rename(tmpPath, this.registryPath);
      this.cache = state;

      // Cloud upload is deliberately NOT awaited. It fetches the memory server
      // with a 15s timeout, and awaiting it made every registry save — i.e.
      // every /api/app/backend write that touches a linked DB — block on a
      // network round trip. In the app that surfaced as "Adding..." hanging for
      // seconds and deletes reporting "Could not delete" after the write had
      // already succeeded on disk.
      //
      // Durability is unaffected: the file rename above is the source of truth,
      // and a failed upload is retried from the metadata outbox.
      //
      // Replica push timestamps are local bookkeeping only — memory server ignores
      // them, so skip uploading ~50KB full registry snapshots on every row write.
      if (!options?.skipCloudUpload) {
        const updatedAt = new Date().toISOString();
        void (async () => {
          try {
            const { uploadDatabasesRegistryToCloud } = await import(
              "./syncV3/MetadataRegistryClient.js"
            );
            await uploadDatabasesRegistryToCloud(state, updatedAt);
          } catch (err) {
            console.warn(
              "[DatabaseRegistry] cloud upload failed:",
              (err as Error).message.slice(0, 120),
            );
          }
        })();
      }
    })();

    const mine = this.saveLock;
    try {
      await mine;
    } finally {
      // Only clear the tail. Unconditional `= null` let a later caller chain
      // onto a lock this one had already dropped, reopening the same race.
      if (this.saveLock === mine) this.saveLock = null;
    }
  }

  private getState(): DatabasesRegistryFile {
    return this.cache ?? defaultRegistry();
  }

  getById(dbId: string): DatabaseRecord | undefined {
    const record = this.getState().databases[dbId];
    if (!record || record.status === "tombstone") {
      return undefined;
    }
    return record;
  }

  async updateLocalPath(dbId: string, localPath: string): Promise<void> {
    const state = this.getState();
    const record = state.databases[dbId];
    if (!record || record.status === "tombstone") {
      return;
    }
    state.databases[dbId] = {
      ...record,
      localPath: normalizeDbPath(localPath),
      updatedAt: new Date().toISOString(),
    };
    await this.save(state);
  }

  /** Mark legacy database as cut over to Plan A replica sync. */
  async markSyncModeReplicaCutover(dbId: string): Promise<void> {
    const state = this.getState();
    const record = state.databases[dbId];
    if (!record || record.status === "tombstone") {
      return;
    }
    const now = new Date().toISOString();
    state.databases[dbId] = {
      ...record,
      syncMode: "replica",
      cutoverAt: now,
      cutoverInProgress: false,
      cutoverStartedAt: undefined,
      cutoverBlocked: false,
      cutoverBlockReason: undefined,
      updatedAt: now,
    };
    await this.save(state);
  }

  async updateReplicaPushState(
    dbId: string,
    patch: {
      lastReplicaPushError?: string | null;
      lastReplicaPushAt?: string | null;
      lastReplicaLocalMutationAt?: string | null;
      cutoverBlocked?: boolean;
      cutoverBlockReason?: string | null;
      cutoverInProgress?: boolean;
      cutoverStartedAt?: string | null;
    },
  ): Promise<void> {
    const state = this.getState();
    const record = state.databases[dbId];
    if (!record || record.status === "tombstone") {
      return;
    }
    state.databases[dbId] = {
      ...record,
      ...(patch.lastReplicaPushError !== undefined
        ? {
            lastReplicaPushError:
              patch.lastReplicaPushError === null
                ? undefined
                : patch.lastReplicaPushError,
          }
        : {}),
      ...(patch.lastReplicaPushAt !== undefined
        ? {
            lastReplicaPushAt:
              patch.lastReplicaPushAt === null
                ? undefined
                : patch.lastReplicaPushAt,
          }
        : {}),
      ...(patch.lastReplicaLocalMutationAt !== undefined
        ? {
            lastReplicaLocalMutationAt:
              patch.lastReplicaLocalMutationAt === null
                ? undefined
                : patch.lastReplicaLocalMutationAt,
          }
        : {}),
      ...(patch.cutoverBlocked !== undefined
        ? { cutoverBlocked: patch.cutoverBlocked }
        : {}),
      ...(patch.cutoverBlockReason !== undefined
        ? {
            cutoverBlockReason:
              patch.cutoverBlockReason === null
                ? undefined
                : patch.cutoverBlockReason,
          }
        : {}),
      ...(patch.cutoverInProgress !== undefined
        ? { cutoverInProgress: patch.cutoverInProgress }
        : {}),
      ...(patch.cutoverStartedAt !== undefined
        ? {
            cutoverStartedAt:
              patch.cutoverStartedAt === null
                ? undefined
                : patch.cutoverStartedAt,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.save(state, { skipCloudUpload: true });
  }

  getByPath(dbPath: string): DatabaseRecord | undefined {
    const normalized = normalizeDbPath(dbPath);
    for (const record of Object.values(this.getState().databases)) {
      if (
        record.status === "active" &&
        normalizeDbPath(record.localPath) === normalized
      ) {
        return record;
      }
    }
    return undefined;
  }

  listActive(): DatabaseRecord[] {
    return Object.values(this.getState().databases).filter(
      (r) => r.status === "active",
    );
  }

  async register(input: {
    localPath: string;
    label?: string;
    ownerJobId?: string;
    schemaOwnerAppId?: string;
    isolation?: DatabaseIsolation;
    dbId?: string;
    tursoShortName?: string;
  }): Promise<DatabaseRecord> {
    const normalizedPath = normalizeDbPath(input.localPath);
    const existing = this.getByPath(normalizedPath);
    if (existing) {
      return existing;
    }

    const dbId = input.dbId ?? newDbId();
    const now = new Date().toISOString();
    const tursoShortName =
      input.tursoShortName ??
      (input.ownerJobId
        ? jobTursoDatabaseName(input.ownerJobId)
        : dbTursoDatabaseName(dbId));

    const syncMode = defaultSyncModeForNewRegistryDb();
    const record: DatabaseRecord = {
      dbId,
      localPath: normalizedPath,
      tursoShortName,
      ...(input.label ? { label: input.label } : {}),
      ...(input.ownerJobId ? { ownerJobId: input.ownerJobId } : {}),
      ...(input.schemaOwnerAppId
        ? { schemaOwnerAppId: input.schemaOwnerAppId }
        : {}),
      isolation: input.isolation ?? "shared",
      status: "active",
      ...(syncMode ? { syncMode } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const state = this.getState();
    state.databases[dbId] = record;
    await this.save(state);

    if (syncMode === "replica") {
      try {
        const { provisionTursoReplicaForRecord } = await import(
          "./tursoReplica/tursoReplicaProvision.js"
        );
        await provisionTursoReplicaForRecord(record);
        await this.updateReplicaPushState(dbId, { lastReplicaPushError: null });
      } catch (error) {
        const message = (error as Error).message.slice(0, 500);
        console.warn(
          `[DatabaseRegistry] Turso replica provision failed for ${dbId}: ${message}`,
        );
        await this.updateReplicaPushState(dbId, {
          lastReplicaPushError: message,
        });
      }
    }

    return record;
  }

  async ensureForPath(
    dbPath: string,
    options?: {
      label?: string;
      ownerJobId?: string;
      schemaOwnerAppId?: string;
    },
  ): Promise<DatabaseRecord> {
    const normalized = normalizeDbPath(dbPath);
    const existing = this.getByPath(normalized);
    if (existing) {
      const ownerJobId = options?.ownerJobId;
      const schemaOwnerAppId = options?.schemaOwnerAppId;
      if (
        (ownerJobId && !existing.ownerJobId) ||
        (schemaOwnerAppId && !existing.schemaOwnerAppId)
      ) {
        const state = this.getState();
        state.databases[existing.dbId] = {
          ...existing,
          ...(ownerJobId && !existing.ownerJobId ? { ownerJobId } : {}),
          ...(schemaOwnerAppId && !existing.schemaOwnerAppId
            ? { schemaOwnerAppId }
            : {}),
          updatedAt: new Date().toISOString(),
        };
        await this.save(state);
        return state.databases[existing.dbId]!;
      }
      return existing;
    }

    const deterministicId = dbIdFromPath(normalized);
    return this.register({
      dbId: deterministicId,
      localPath: normalized,
      label: options?.label,
      ownerJobId: options?.ownerJobId,
      schemaOwnerAppId: options?.schemaOwnerAppId,
    });
  }

  /** Registry DBs whose migration SQL ships in this app's repo (schema owner). */
  listBySchemaOwnerApp(appId: string): DatabaseRecord[] {
    const trimmed = appId.trim();
    if (!trimmed) {
      return [];
    }
    return Object.values(this.getState().databases).filter(
      (record) =>
        record.status === "active" && record.schemaOwnerAppId === trimmed,
    );
  }

  isSchemaOwner(appId: string, dbId: string): boolean {
    const record = this.getById(dbId);
    return record?.schemaOwnerAppId === appId.trim();
  }

  async setIsolation(
    dbId: string,
    isolation: DatabaseIsolation,
  ): Promise<DatabaseRecord> {
    const state = this.getState();
    const record = state.databases[dbId];
    if (!record || record.status !== "active") {
      throw new Error(`Database not found: ${dbId}`);
    }
    record.isolation = isolation;
    record.updatedAt = new Date().toISOString();
    await this.save(state);
    return record;
  }

  async tombstone(dbId: string): Promise<void> {
    const state = this.getState();
    const record = state.databases[dbId];
    if (!record) {
      return;
    }
    record.status = "tombstone";
    record.updatedAt = new Date().toISOString();
    await this.save(state);
  }

  /**
   * Count app data-source references to a database (by dbId or normalized path).
   */
  async countReferences(dbId: string, dbPath: string): Promise<number> {
    const normalized = normalizeDbPath(dbPath);
    if (!fs.existsSync(this.appsRootDir)) {
      return 0;
    }

    const entries = await fs.promises.readdir(this.appsRootDir, {
      withFileTypes: true,
    });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const configPath = path.join(
        this.appsRootDir,
        entry.name,
        "data-sources.json",
      );
      let raw: string;
      try {
        raw = await fs.promises.readFile(configPath, "utf8");
      } catch {
        continue;
      }
      try {
        const config = parseDataSourcesFile(raw);
        for (const source of config.sources) {
          if (
            source.dbId === dbId ||
            normalizeDbPath(source.dbPath) === normalized
          ) {
            count += 1;
          }
        }
      } catch {
        continue;
      }
    }

    return count;
  }

  /** App IDs whose data-sources.json references this database. */
  async listReferencingAppIds(
    dbId: string,
    dbPath: string,
  ): Promise<string[]> {
    const normalized = normalizeDbPath(dbPath);
    if (!fs.existsSync(this.appsRootDir)) {
      return [];
    }

    const appIds: string[] = [];
    const entries = await fs.promises.readdir(this.appsRootDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const configPath = path.join(
        this.appsRootDir,
        entry.name,
        "data-sources.json",
      );
      let raw: string;
      try {
        raw = await fs.promises.readFile(configPath, "utf8");
      } catch {
        continue;
      }
      try {
        const config = parseDataSourcesFile(raw);
        const matches = config.sources.some(
          (source) =>
            source.dbId === dbId ||
            normalizeDbPath(source.dbPath) === normalized,
        );
        if (matches) {
          appIds.push(entry.name);
        }
      } catch {
        continue;
      }
    }

    return appIds;
  }

  /**
   * Backfill registry from existing app data-sources (dedupe by normalized dbPath).
   */
  async backfillFromAppsIfNeeded(): Promise<number> {
    if (!fs.existsSync(this.appsRootDir)) {
      return 0;
    }

    const entries = await fs.promises.readdir(this.appsRootDir, {
      withFileTypes: true,
    });
    const byPath = new Map<
      string,
      {
        dbPath: string;
        label?: string;
        ownerJobId?: string;
        schemaOwnerAppId?: string;
      }
    >();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const configPath = path.join(
        this.appsRootDir,
        entry.name,
        "data-sources.json",
      );
      let raw: string;
      try {
        raw = await fs.promises.readFile(configPath, "utf8");
      } catch {
        continue;
      }
      try {
        const config = parseDataSourcesFile(raw);
        for (const source of config.sources) {
          if (!source.dbPath) {
            continue;
          }
          const normalized = normalizeDbPath(source.dbPath);
          const existing = byPath.get(normalized);
          if (!existing) {
            byPath.set(normalized, {
              dbPath: normalized,
              label: source.alias,
              ownerJobId: source.jobId,
              schemaOwnerAppId: entry.name,
            });
          } else {
            if (!existing.ownerJobId && source.jobId) {
              existing.ownerJobId = source.jobId;
            }
            if (!existing.schemaOwnerAppId) {
              existing.schemaOwnerAppId = entry.name;
            }
          }
        }
      } catch {
        continue;
      }
    }

    let added = 0;
    for (const item of byPath.values()) {
      const before = this.getByPath(item.dbPath);
      await this.ensureForPath(item.dbPath, {
        label: item.label,
        ownerJobId: item.ownerJobId,
        schemaOwnerAppId: item.schemaOwnerAppId,
      });
      if (!before) {
        added += 1;
      }
    }
    return added;
  }

  enrichSource(source: AppDataSource): AppDataSource {
    const record = this.getRecordForSource(source);
    if (!record) {
      return source;
    }
    if (source.dbId === record.dbId) {
      return source;
    }
    return { ...source, dbId: record.dbId };
  }

  /** Lookup by dbId, then normalized dbPath. */
  getRecordForSource(source: AppDataSource): DatabaseRecord | undefined {
    if (source.dbId) {
      const byId = this.getById(source.dbId);
      if (byId) {
        return byId;
      }
    }
    if (source.dbPath) {
      return this.getByPath(source.dbPath);
    }
    return undefined;
  }

  /**
   * Merge registry entries from synced git (cloud host). Does not write disk.
   * Newer updatedAt wins when the same dbId exists locally.
   */
  mergeFromRegistryFile(raw: string): number {
    let parsed: DatabasesRegistryFile;
    try {
      parsed = JSON.parse(raw) as DatabasesRegistryFile;
    } catch {
      return 0;
    }
    if (!parsed?.databases || typeof parsed.databases !== "object") {
      return 0;
    }

    const state = this.getState();
    let merged = 0;
    for (const [dbId, incoming] of Object.entries(parsed.databases)) {
      if (!incoming || incoming.status === "tombstone") {
        continue;
      }
      const existing = state.databases[dbId];
      if (
        !existing ||
        existing.status === "tombstone" ||
        incoming.updatedAt > existing.updatedAt
      ) {
        state.databases[dbId] = incoming;
        merged += 1;
      }
    }
    this.cache = state;
    return merged;
  }

  /**
   * Ensure an in-memory registry record exists for Turso routing (cloud fallback).
   * Only used when databases.json is missing entries — assumes shared isolation.
   */
  ensureRecordForSource(source: AppDataSource): DatabaseRecord {
    const existing = this.getRecordForSource(source);
    if (existing) {
      return existing;
    }

    if (!source.dbPath) {
      throw new Error(
        `Cannot resolve database registry record for source ${source.alias}: missing dbPath`,
      );
    }

    const normalizedPath = normalizeDbPath(source.dbPath);
    const dbId = source.dbId ?? dbIdFromPath(normalizedPath);
    const now = new Date().toISOString();
    const record: DatabaseRecord = {
      dbId,
      localPath: normalizedPath,
      tursoShortName: source.jobId
        ? jobTursoDatabaseName(source.jobId)
        : dbTursoDatabaseName(dbId),
      ...(source.alias ? { label: source.alias } : {}),
      ...(source.jobId ? { ownerJobId: source.jobId } : {}),
      isolation: "shared",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    const state = this.getState();
    state.databases[dbId] = record;
    this.cache = state;
    return record;
  }
}

export function getDatabaseRegistryService(): DatabaseRegistryService {
  if (!registryInstance) {
    registryInstance = new DatabaseRegistryService();
  }
  return registryInstance;
}

export async function initializeDatabaseRegistry(): Promise<DatabaseRegistryService> {
  const service = getDatabaseRegistryService();
  await service.initialize();
  return service;
}

/** Reset singleton after org/namespace workspace switch. */
export function resetDatabaseRegistryForWorkspaceSwitch(): void {
  registryInstance = null;
}
