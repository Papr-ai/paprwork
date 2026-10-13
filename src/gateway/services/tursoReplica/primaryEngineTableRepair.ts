/**
 * Repair the sync engine's bookkeeping table on the Turso *primary*.
 *
 * The engine keeps `turso_sync_last_change_id` on the primary to remember how far each
 * client has pushed, and reads it back with strict types: `pull_gen` and `change_id` must be
 * integers. A copy created with TEXT columns and no primary key (the same degraded shape
 * `replicaEngineTableGuard` drops locally) makes every push and pull fail with
 *
 *   database sync engine error: failed to read last_change_id after remote apply:
 *   database sync engine error: unexpected source pull_gen type
 *
 * The local guard cannot cure it: the replica re-downloads the bad table from the primary on
 * the very next pull. So the repair runs on the primary: rebuild the table in its canonical
 * shape, keep each client's counters (cast to integers), all in one transaction. App tables
 * are never touched.
 */
import type { Client, InStatement } from "@libsql/client";

export const LAST_CHANGE_ID_TABLE = "turso_sync_last_change_id";

/** Exactly what the engine creates (CREATE TABLE IF NOT EXISTS in @tursodatabase/sync). */
export const CANONICAL_LAST_CHANGE_ID_SQL =
  "CREATE TABLE turso_sync_last_change_id (client_id TEXT PRIMARY KEY, pull_gen INTEGER, change_id INTEGER)";

/**
 * The engine's catchable errors when the primary holds the degraded table.
 * Typed-but-keyless is the push-side symptom: the engine upserts its counter row with
 * ON CONFLICT(client_id), which SQLite rejects when client_id is not a key. The same
 * message can come from an app table, so the caller only retries when the repair
 * actually found (and fixed) a defect; a healthy table means "not ours, rethrow".
 */
export function isPrimaryEngineTableTypeError(message: string): boolean {
  return /unexpected source (pull_gen|change_id) type/i.test(message) ||
    /unexpected MAX\(change_id\) column type/i.test(message) ||
    /ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint/i.test(message);
}

type Remote = Pick<Client, "execute" | "batch">;

interface ColumnInfo { name: string; type: string; pk: number }

export interface PrimaryEngineTableReport {
  /** Table missing, or already canonical: nothing to do. */
  healthy: boolean;
  defects: string[];
}

export async function inspectPrimaryLastChangeIdTable(remote: Remote): Promise<PrimaryEngineTableReport> {
  const info = await remote.execute(`PRAGMA table_info(${LAST_CHANGE_ID_TABLE})`);
  if (info.rows.length === 0) return { healthy: true, defects: [] };
  const cols = new Map<string, ColumnInfo>(
    info.rows.map((r) => [String(r.name), { name: String(r.name), type: String(r.type ?? "").toUpperCase(), pk: Number(r.pk ?? 0) }]),
  );
  const defects: string[] = [];
  const clientId = cols.get("client_id");
  if (!clientId) defects.push("no client_id column");
  else if (clientId.pk !== 1) defects.push("client_id is not the primary key");
  for (const name of ["pull_gen", "change_id"]) {
    const c = cols.get(name);
    if (!c) defects.push(`no ${name} column`);
    else if (c.type !== "INTEGER") defects.push(`${name} is ${c.type || "untyped"}, not INTEGER`);
  }
  return { healthy: defects.length === 0, defects };
}

export interface PrimaryEngineTableRepair {
  repaired: boolean;
  defects: string[];
  /** Client rows carried over with integer counters. */
  keptRows: number;
  /** Rows whose counters were not numbers; the engine re-initializes those clients. */
  droppedRows: number;
}

const toInt = (v: unknown): number | null => {
  const n = typeof v === "bigint" ? Number(v) : Number(String(v ?? "").trim());
  return Number.isFinite(n) && Number.isInteger(n) && String(v ?? "").trim() !== "" ? n : null;
};

/** Rebuild the table on the primary when it isn't canonical. No-op when it is. */
export async function repairPrimaryLastChangeIdTable(remote: Remote): Promise<PrimaryEngineTableRepair> {
  const report = await inspectPrimaryLastChangeIdTable(remote);
  if (report.healthy) return { repaired: false, defects: [], keptRows: 0, droppedRows: 0 };

  const existing = report.defects.includes("no client_id column")
    ? []
    : (await remote.execute(`SELECT * FROM ${LAST_CHANGE_ID_TABLE}`)).rows;
  // One row per client (a table without a primary key can hold duplicates): keep the furthest one.
  const best = new Map<string, { pullGen: number; changeId: number }>();
  let droppedRows = 0;
  for (const r of existing) {
    const id = r.client_id == null ? "" : String(r.client_id);
    const pullGen = toInt(r.pull_gen), changeId = toInt(r.change_id);
    if (!id || pullGen === null || changeId === null) { droppedRows++; continue; }
    const prev = best.get(id);
    if (prev && (prev.pullGen > pullGen || (prev.pullGen === pullGen && prev.changeId >= changeId))) { droppedRows++; continue; }
    if (prev) droppedRows++;
    best.set(id, { pullGen, changeId });
  }

  const stmts: InStatement[] = [
    `DROP TABLE ${LAST_CHANGE_ID_TABLE}`,
    CANONICAL_LAST_CHANGE_ID_SQL,
    ...[...best].map(([id, v]) => ({
      sql: `INSERT INTO ${LAST_CHANGE_ID_TABLE} (client_id, pull_gen, change_id) VALUES (?, ?, ?)`,
      args: [id, v.pullGen, v.changeId],
    })),
  ];
  await remote.batch(stmts, "write"); // all or nothing
  return { repaired: true, defects: report.defects, keptRows: best.size, droppedRows };
}
