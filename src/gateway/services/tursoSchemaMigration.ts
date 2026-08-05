/**
 * Incremental SQLite schema migrations for Turso boundary sync.
 * Applies surgical DDL (ADD/DROP/RENAME COLUMN) instead of full table replace
 * when the change set is safe. Falls back to table rebuild only for type/PK
 * changes or ambiguous renames.
 */

import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import {
  quoteIdent,
  readTableSchema,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import { fullSchemasMatch } from "./tursoTableFingerprint.js";
import { isPlatformManagedColumn } from "./tursoTableFingerprint.js";
import {
  dropLocalTableSyncTriggers,
  dropRemoteTableSyncTriggers,
} from "./tursoSyncLog.js";

export type SchemaMigrationStep =
  | { kind: "add_column"; column: TableColumn }
  | { kind: "drop_column"; name: string }
  | { kind: "rename_column"; from: string; to: string };

export interface SchemaMigrationPlan {
  steps: SchemaMigrationStep[];
  requiresTableRebuild: boolean;
  rebuildReason?: string;
}

function normalizeType(type: string): string {
  return type.trim().toUpperCase() || "TEXT";
}

function columnSignature(col: TableColumn): string {
  return `${col.name}:${normalizeType(col.type)}:${col.primaryKey ? 1 : 0}`;
}

/** Plan DDL to morph `current` schema into `desired`. */
export function planSchemaMigration(
  currentColumns: TableColumn[],
  desiredColumns: TableColumn[],
): SchemaMigrationPlan {
  const currentByName = new Map(currentColumns.map((col) => [col.name, col]));
  const desiredByName = new Map(desiredColumns.map((col) => [col.name, col]));

  const toAdd = desiredColumns.filter((col) => !currentByName.has(col.name));
  const toRemove = currentColumns.filter(
    (col) => !desiredByName.has(col.name) && !isPlatformManagedColumn(col.name),
  );

  const modified = desiredColumns.filter((col) => {
    const current = currentByName.get(col.name);
    return current !== undefined && columnSignature(current) !== columnSignature(col);
  });

  if (modified.length > 0) {
    return {
      steps: [],
      requiresTableRebuild: true,
      rebuildReason: `column type or primary-key change: ${modified.map((col) => col.name).join(", ")}`,
    };
  }

  if (toRemove.length === 1 && toAdd.length === 1) {
    const removed = toRemove[0]!;
    const added = toAdd[0]!;
    const removedShape = `${normalizeType(removed.type)}:${removed.primaryKey ? 1 : 0}`;
    const addedShape = `${normalizeType(added.type)}:${added.primaryKey ? 1 : 0}`;
    if (removedShape === addedShape) {
      return {
        steps: [{ kind: "rename_column", from: removed.name, to: added.name }],
        requiresTableRebuild: false,
      };
    }
  }

  const steps: SchemaMigrationStep[] = [
    ...toAdd.map((column) => ({ kind: "add_column" as const, column })),
    ...toRemove.map((col) => ({ kind: "drop_column" as const, name: col.name })),
  ];

  return { steps, requiresTableRebuild: false };
}

export async function applySchemaMigrationToRemote(
  remote: Client,
  tableName: string,
  plan: SchemaMigrationPlan,
): Promise<void> {
  if (plan.requiresTableRebuild) {
    throw new Error(plan.rebuildReason ?? "schema rebuild required");
  }

  for (const step of plan.steps) {
    switch (step.kind) {
      case "add_column": {
        const type = step.column.type.trim() || "TEXT";
        await remote.execute({
          sql:
            `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(step.column.name)} ${type}`,
          args: [],
        });
        break;
      }
      case "drop_column":
        await remote.execute({
          sql: `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(step.name)}`,
          args: [],
        });
        break;
      case "rename_column":
        await remote.execute({
          sql:
            `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(step.from)} TO ${quoteIdent(step.to)}`,
          args: [],
        });
        break;
    }
  }
}

export function applySchemaMigrationToLocal(
  localDb: Database.Database,
  tableName: string,
  plan: SchemaMigrationPlan,
): void {
  if (plan.requiresTableRebuild) {
    throw new Error(plan.rebuildReason ?? "schema rebuild required");
  }

  for (const step of plan.steps) {
    switch (step.kind) {
      case "add_column": {
        const type = step.column.type.trim() || "TEXT";
        localDb.exec(
          `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(step.column.name)} ${type}`,
        );
        break;
      }
      case "drop_column":
        localDb.exec(
          `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(step.name)}`,
        );
        break;
      case "rename_column":
        localDb.exec(
          `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(step.from)} TO ${quoteIdent(step.to)}`,
        );
        break;
    }
  }
}

/** Migrate remote table schema toward `desiredColumns` without touching row data when possible. */
export async function migrateRemoteTableSchemaFromColumns(
  remote: Client,
  tableName: string,
  desiredColumns: TableColumn[],
  onRebuildRequired: () => Promise<void>,
): Promise<"migrated" | "rebuilt" | "unchanged"> {
  if (desiredColumns.length === 0) {
    return "unchanged";
  }

  const remoteResult = await remote.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  if (remoteResult.rows.length === 0) {
    return "unchanged";
  }

  const current = remoteResult.rows.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? "TEXT"),
    primaryKey: Number(row.pk ?? 0) > 0,
  }));

  if (fullSchemasMatch(current, desiredColumns)) {
    return "unchanged";
  }

  const plan = planSchemaMigration(current, desiredColumns);
  if (plan.requiresTableRebuild) {
    await onRebuildRequired();
    return "rebuilt";
  }

  if (plan.steps.length === 0) {
    return "unchanged";
  }

  await dropRemoteTableSyncTriggers(remote, tableName);
  await applySchemaMigrationToRemote(remote, tableName, plan);
  return "migrated";
}

/** Migrate remote table schema toward local without touching row data when possible. */
export async function migrateRemoteTableSchema(
  remote: Client,
  localDb: Database.Database,
  tableName: string,
  onRebuildRequired: () => Promise<void>,
): Promise<"migrated" | "rebuilt" | "unchanged"> {
  const desired = readTableSchema(localDb, tableName);
  return migrateRemoteTableSchemaFromColumns(
    remote,
    tableName,
    desired,
    onRebuildRequired,
  );
}

/** Migrate local table schema toward remote (pull direction). */
export function migrateLocalTableSchema(
  localDb: Database.Database,
  remote: Client,
  tableName: string,
): Promise<"migrated" | "unchanged"> {
  return (async () => {
    const current = readTableSchema(localDb, tableName);
    const remoteResult = await remote.execute(
      `PRAGMA table_info(${quoteIdent(tableName)})`,
    );
    if (remoteResult.rows.length === 0) {
      return "unchanged";
    }

    const desired = remoteResult.rows.map((row) => ({
      name: String(row.name ?? ""),
      type: String(row.type ?? "TEXT"),
      primaryKey: Number(row.pk ?? 0) > 0,
    }));

    if (current.length === 0) {
      return "unchanged";
    }

    const desiredSig = desired.map(columnSignature).join("|");
    const currentSig = current.map(columnSignature).join("|");
    if (desiredSig === currentSig) {
      return "unchanged";
    }

    const plan = planSchemaMigration(current, desired);
    if (plan.requiresTableRebuild || plan.steps.length === 0) {
      return "unchanged";
    }

    dropLocalTableSyncTriggers(localDb, tableName);
    applySchemaMigrationToLocal(localDb, tableName, plan);
    return "migrated";
  })();
}
