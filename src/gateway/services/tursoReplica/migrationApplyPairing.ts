/**
 * Pairing tokens for explicit replica ↔ Turso primary migration applies.
 */

import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { promises as fsPromises } from "fs";

export interface MigrationApplyPairRecord {
  applyToken: string;
  migrationId: string;
  sqlChecksum: string;
  replicaAppliedAt: string | null;
  cloudAppliedAt: string | null;
  pairedAt: string | null;
  createdAt: string;
}

interface MigrationApplyPairsFile {
  version: 1;
  pairs: Record<string, MigrationApplyPairRecord>;
}

const PAIRS_FILENAME = "migration-apply-pairs.json";

export function computeMigrationSqlChecksum(sql: string): string {
  return createHash("sha256").update(sql.trim(), "utf8").digest("hex");
}

export function migrationPairsFilePath(migrationRoot: string): string {
  return path.join(migrationRoot, PAIRS_FILENAME);
}

async function readPairsFile(migrationRoot: string): Promise<MigrationApplyPairsFile> {
  const filePath = migrationPairsFilePath(migrationRoot);
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as MigrationApplyPairsFile;
    if (parsed.version === 1 && parsed.pairs && typeof parsed.pairs === "object") {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return { version: 1, pairs: {} };
}

async function writePairsFile(
  migrationRoot: string,
  file: MigrationApplyPairsFile,
): Promise<void> {
  const filePath = migrationPairsFilePath(migrationRoot);
  await fsPromises.mkdir(migrationRoot, { recursive: true });
  await fsPromises.writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function newApplyToken(): string {
  return `map_${randomBytes(8).toString("hex")}`;
}

export async function createMigrationApplyPair(options: {
  migrationRoot: string;
  migrationId: string;
  sqlChecksum: string;
  replicaAppliedAt?: string;
}): Promise<MigrationApplyPairRecord> {
  const file = await readPairsFile(options.migrationRoot);
  const existing = file.pairs[options.migrationId];
  if (
    existing &&
    existing.sqlChecksum === options.sqlChecksum &&
    !existing.pairedAt
  ) {
    if (options.replicaAppliedAt && !existing.replicaAppliedAt) {
      existing.replicaAppliedAt = options.replicaAppliedAt;
      await writePairsFile(options.migrationRoot, file);
    }
    return existing;
  }

  const record: MigrationApplyPairRecord = {
    applyToken: newApplyToken(),
    migrationId: options.migrationId,
    sqlChecksum: options.sqlChecksum,
    replicaAppliedAt: options.replicaAppliedAt ?? null,
    cloudAppliedAt: null,
    pairedAt: null,
    createdAt: new Date().toISOString(),
  };
  file.pairs[options.migrationId] = record;
  await writePairsFile(options.migrationRoot, file);
  return record;
}

export async function getMigrationApplyPair(
  migrationRoot: string,
  migrationId: string,
): Promise<MigrationApplyPairRecord | null> {
  const file = await readPairsFile(migrationRoot);
  return file.pairs[migrationId] ?? null;
}

export async function validateMigrationApplyToken(options: {
  migrationRoot: string;
  migrationId: string;
  applyToken: string;
  sqlChecksum: string;
}): Promise<MigrationApplyPairRecord> {
  const record = await getMigrationApplyPair(options.migrationRoot, options.migrationId);
  if (!record) {
    throw new Error(
      `No migration apply pair for ${options.migrationId}. ` +
        "Run papr_db_apply_migration_replica first.",
    );
  }
  if (record.applyToken !== options.applyToken.trim()) {
    throw new Error(
      `applyToken mismatch for migration ${options.migrationId}. ` +
        "Use the token returned from papr_db_apply_migration_replica.",
    );
  }
  if (record.sqlChecksum !== options.sqlChecksum) {
    throw new Error(
      `Migration SQL checksum mismatch for ${options.migrationId}. ` +
        "The migration file changed since replica apply — start over with replica apply.",
    );
  }
  return record;
}

export async function markMigrationCloudApplied(options: {
  migrationRoot: string;
  migrationId: string;
  applyToken: string;
}): Promise<MigrationApplyPairRecord> {
  const file = await readPairsFile(options.migrationRoot);
  const record = file.pairs[options.migrationId];
  if (!record || record.applyToken !== options.applyToken.trim()) {
    throw new Error(`Invalid applyToken for migration ${options.migrationId}`);
  }
  record.cloudAppliedAt = new Date().toISOString();
  if (record.replicaAppliedAt) {
    record.pairedAt = new Date().toISOString();
  }
  await writePairsFile(options.migrationRoot, file);
  return record;
}

export async function markMigrationReplicaApplied(options: {
  migrationRoot: string;
  migrationId: string;
  applyToken: string;
}): Promise<MigrationApplyPairRecord> {
  const file = await readPairsFile(options.migrationRoot);
  const record = file.pairs[options.migrationId];
  if (!record || record.applyToken !== options.applyToken.trim()) {
    throw new Error(`Invalid applyToken for migration ${options.migrationId}`);
  }
  record.replicaAppliedAt = new Date().toISOString();
  if (record.cloudAppliedAt) {
    record.pairedAt = new Date().toISOString();
  }
  await writePairsFile(options.migrationRoot, file);
  return record;
}

export async function completeMigrationPairing(options: {
  migrationRoot: string;
  migrationId: string;
  applyToken: string;
}): Promise<MigrationApplyPairRecord> {
  const file = await readPairsFile(options.migrationRoot);
  const record = file.pairs[options.migrationId];
  if (!record || record.applyToken !== options.applyToken.trim()) {
    throw new Error(`Invalid applyToken for migration ${options.migrationId}`);
  }
  if (!record.replicaAppliedAt || !record.cloudAppliedAt) {
    throw new Error(
      `Migration ${options.migrationId} is not applied on both replica and cloud primary.`,
    );
  }
  record.pairedAt = new Date().toISOString();
  await writePairsFile(options.migrationRoot, file);
  return record;
}

export async function listUnpairedMigrations(
  migrationRoot: string,
): Promise<MigrationApplyPairRecord[]> {
  const file = await readPairsFile(migrationRoot);
  return Object.values(file.pairs).filter((record) => !record.pairedAt);
}

export function migrationPairsFileExists(migrationRoot: string): boolean {
  return fs.existsSync(migrationPairsFilePath(migrationRoot));
}
