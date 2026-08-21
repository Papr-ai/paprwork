/**
 * _papr_materialized gate — skip replay of workspace log seq on local SQLite.
 */

import type { DbQueryPool } from "../DbQueryPool.js";

const MATERIALIZED_DDL = `
CREATE TABLE IF NOT EXISTS _papr_materialized (
  replica_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, seq)
)
`;

export async function ensureMaterializedTable(
  pool: DbQueryPool,
  appId: string,
  dbPath: string,
): Promise<void> {
  await pool.exec(appId, dbPath, MATERIALIZED_DDL);
}

export async function isSeqMaterialized(
  pool: DbQueryPool,
  appId: string,
  dbPath: string,
  replicaId: string,
  seq: number,
): Promise<boolean> {
  await ensureMaterializedTable(pool, appId, dbPath);
  const result = await pool.query(
    appId,
    dbPath,
    "SELECT 1 AS ok FROM _papr_materialized WHERE replica_id = ? AND seq = ? LIMIT 1",
    [replicaId, seq],
  );
  return result.count > 0;
}

export async function markSeqMaterialized(
  pool: DbQueryPool,
  appId: string,
  dbPath: string,
  replicaId: string,
  seq: number,
): Promise<void> {
  await ensureMaterializedTable(pool, appId, dbPath);
  await pool.write(
    appId,
    dbPath,
    "INSERT OR IGNORE INTO _papr_materialized (replica_id, seq, applied_at) VALUES (?, ?, ?)",
    [replicaId, seq, new Date().toISOString()],
  );
}
