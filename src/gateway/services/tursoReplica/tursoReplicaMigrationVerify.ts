/**
 * Verify migrations against the embedded Turso Sync replica handle — NOT the
 * on-disk data.db file (better-sqlite3 reads stale WAL state and disagrees with
 * what @tursodatabase/sync serves).
 */

import type { Client } from "@libsql/client";
import type { AppDataSource } from "../appDataSources.js";
import { isMigrationLedgerMarker } from "../jobs/migrationLedgerPolicy.js";
import {
  verifyMigrationOnRemote,
  type MigrationVerification,
} from "../jobs/jobMigrationLedgerSync.js";
import { queryLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";

function createReplicaSchemaClient(source: AppDataSource): Client {
  const adapter = {
    execute: async (
      arg: string | { sql: string; args?: unknown[] },
    ): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const params = typeof arg === "string" ? [] : (arg.args ?? []);
      const result = await queryLinkedDbViaTursoReplica(source, sql, params, {
        pullBeforeRead: false,
      });
      const columns =
        result.rows.length > 0
          ? Object.keys(result.rows[0] as Record<string, unknown>)
          : [];
      return {
        rows: result.rows as Record<string, unknown>[],
        columns,
      };
    },
    batch: async () => {
      throw new Error("Replica schema client does not support batch");
    },
    executeMultiple: async () => {
      throw new Error("Replica schema client does not support executeMultiple");
    },
    transaction: async () => {
      throw new Error("Replica schema client does not support transaction");
    },
    close: () => {
      /* no-op */
    },
  };
  return adapter as unknown as Client;
}

export async function verifyMigrationOnReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<MigrationVerification> {
  const client = createReplicaSchemaClient(source);
  try {
    return await verifyMigrationOnRemote(client, migrationRoot, migrationId);
  } finally {
    client.close();
  }
}

export async function migrationSatisfiedOnReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const bareId = migrationId.replace(/\.sql$/, "");
  if (isMigrationLedgerMarker(bareId) || isMigrationLedgerMarker(migrationId)) {
    return true;
  }
  const result = await verifyMigrationOnReplica(source, migrationRoot, migrationId);
  return result.satisfied;
}

const USER_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

export async function listReplicaUserTables(
  source: AppDataSource,
): Promise<string[]> {
  const result = await queryLinkedDbViaTursoReplica(
    source,
    USER_TABLES_SQL,
    [],
    { pullBeforeRead: false },
  );
  return result.rows
    .map((row) => String((row as Record<string, unknown>).name ?? "").trim())
    .filter((name) => name.length > 0);
}

export async function listCloudUserTables(
  tursoDatabase: string,
): Promise<string[]> {
  const { openTursoPrimaryClient } = await import("../jobs/jobMigrationTursoSync.js");
  const client = await openTursoPrimaryClient(tursoDatabase);
  try {
    const result = await client.execute(USER_TABLES_SQL);
    return result.rows
      .map((row) => String(row.name ?? "").trim())
      .filter((name) => name.length > 0);
  } finally {
    client.close();
  }
}

export function diffTableSets(
  replicaTables: readonly string[],
  cloudTables: readonly string[],
): {
  replicaOnlyTables: string[];
  cloudOnlyTables: string[];
  schemaPaired: boolean;
} {
  const cloudSet = new Set(cloudTables);
  const replicaSet = new Set(replicaTables);
  const replicaOnlyTables = replicaTables.filter((t) => !cloudSet.has(t));
  const cloudOnlyTables = cloudTables.filter((t) => !replicaSet.has(t));
  return {
    replicaOnlyTables,
    cloudOnlyTables,
    schemaPaired:
      replicaOnlyTables.length === 0 && cloudOnlyTables.length === 0,
  };
}
