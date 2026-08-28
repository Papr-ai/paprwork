/**
 * Load and validate {migrationRoot}/migrations/manifest.json
 * (registry DB or job scratch directory).
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  JOB_MIGRATION_MANIFEST_FILE,
  JOB_MIGRATION_MANIFEST_VERSION,
  type JobMigrationEntry,
  type JobMigrationManifest,
  type JobMigrationSchemaOp,
} from "../../../core/types/jobMigrations.js";
import { rowVersionMigrationSql } from "../rowSyncColumns.js";

export { rowVersionMigrationSql };

export function migrationsDir(jobDir: string): string {
  return path.join(jobDir, "migrations");
}

export function manifestPath(jobDir: string): string {
  return path.join(migrationsDir(jobDir), JOB_MIGRATION_MANIFEST_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSchemaOp(raw: unknown): JobMigrationSchemaOp | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "add_column":
      if (
        typeof raw.table === "string" &&
        typeof raw.column === "string" &&
        typeof raw.type === "string"
      ) {
        return {
          kind: "add_column",
          table: raw.table,
          column: raw.column,
          type: raw.type,
        };
      }
      return null;
    case "drop_column":
      if (typeof raw.table === "string" && typeof raw.column === "string") {
        return { kind: "drop_column", table: raw.table, column: raw.column };
      }
      return null;
    case "rename_column":
      if (
        typeof raw.table === "string" &&
        typeof raw.from === "string" &&
        typeof raw.to === "string"
      ) {
        return {
          kind: "rename_column",
          table: raw.table,
          from: raw.from,
          to: raw.to,
        };
      }
      return null;
    case "sql":
      if (typeof raw.statement === "string" && raw.statement.trim().length > 0) {
        return { kind: "sql", statement: raw.statement.trim() };
      }
      return null;
    default:
      return null;
  }
}

function parseEntry(raw: unknown): JobMigrationEntry | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }
  const entry: JobMigrationEntry = { id: raw.id };
  if (typeof raw.description === "string") {
    entry.description = raw.description;
  }
  if (typeof raw.checksum === "string") {
    entry.checksum = raw.checksum;
  }
  if (Array.isArray(raw.ops)) {
    const ops = raw.ops
      .map(parseSchemaOp)
      .filter((op): op is JobMigrationSchemaOp => op !== null);
    if (ops.length > 0) {
      entry.ops = ops;
    }
  }
  return entry;
}

export function parseJobMigrationManifest(raw: unknown): JobMigrationManifest | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.formatVersion !== JOB_MIGRATION_MANIFEST_VERSION) {
    return null;
  }
  if (typeof raw.schemaVersion !== "number" || !Number.isFinite(raw.schemaVersion)) {
    return null;
  }
  if (!Array.isArray(raw.migrations)) {
    return null;
  }
  const migrations = raw.migrations
    .map(parseEntry)
    .filter((entry): entry is JobMigrationEntry => entry !== null);
  return {
    formatVersion: JOB_MIGRATION_MANIFEST_VERSION,
    schemaVersion: raw.schemaVersion,
    migrations,
  };
}

export async function loadJobMigrationManifest(
  jobDir: string,
): Promise<JobMigrationManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(jobDir), "utf8");
    return parseJobMigrationManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Manifest entry by migration id (SQL filename). */
export function manifestEntryById(
  manifest: JobMigrationManifest | null,
  migrationId: string,
): JobMigrationEntry | undefined {
  return manifest?.migrations.find((entry) => entry.id === migrationId);
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function listMigrationSqlFiles(jobDir: string): Promise<string[]> {
  const dir = migrationsDir(jobDir);
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith(".sql")).sort();
  } catch {
    return [];
  }
}

export async function readMigrationSql(
  jobDir: string,
  migrationId: string,
): Promise<string | null> {
  const fileName = migrationId.endsWith(".sql")
    ? migrationId
    : `${migrationId}.sql`;
  try {
    return await fs.readFile(path.join(migrationsDir(jobDir), fileName), "utf8");
  } catch {
    return null;
  }
}
