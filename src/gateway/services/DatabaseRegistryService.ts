/**
 * Independent database registry — ~/Papr/data/databases.json
 *
 * Databases are first-class resources; apps/jobs attach via data-sources.json.
 * Turso short names: legacy j-{jobId8} or d-{dbId8} for standalone DBs.
 */

import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import {
  dbTursoDatabaseName,
  jobTursoDatabaseName,
  resolveTursoShortName,
} from "./tursoDatabaseNaming.js";
import {
  parseDataSourcesFile,
  type AppDataSource,
} from "./appDataSources.js";

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
  createdAt: string;
  updatedAt: string;
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

  constructor(paprDataDir?: string, appsRootDir?: string) {
    const dataDir = paprDataDir ?? getPaprDataDir();
    this.registryPath = path.join(dataDir, DATABASES_REGISTRY_FILENAME);
    this.appsRootDir =
      appsRootDir ?? path.join(path.dirname(dataDir), "apps");
  }

  async initialize(): Promise<void> {
    this.cache = await this.load();
    await this.backfillFromAppsIfNeeded();
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

  private async save(state: DatabasesRegistryFile): Promise<void> {
    if (this.saveLock) {
      await this.saveLock;
    }

    this.saveLock = (async () => {
      const tmpPath = `${this.registryPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.promises.mkdir(path.dirname(this.registryPath), {
        recursive: true,
      });
      await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
      await fs.promises.rename(tmpPath, this.registryPath);
      this.cache = state;

      const updatedAt = new Date().toISOString();
      void import("./syncV3/MetadataRegistryClient.js")
        .then(({ uploadDatabasesRegistryToCloud }) =>
          uploadDatabasesRegistryToCloud(state, updatedAt),
        )
        .catch((err: Error) => {
          console.warn(
            "[DatabaseRegistry] cloud upload failed:",
            err.message.slice(0, 120),
          );
        });
    })();

    try {
      await this.saveLock;
    } finally {
      this.saveLock = null;
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
      createdAt: now,
      updatedAt: now,
    };

    const state = this.getState();
    state.databases[dbId] = record;
    await this.save(state);
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
