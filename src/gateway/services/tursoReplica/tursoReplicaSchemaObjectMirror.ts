/**
 * Turso Sync carries tables, columns, indexes and rows to the cloud primary,
 * but NOT triggers or views: a migration applied on the replica and pushed
 * left the cloud without them (verified live against @tursodatabase/sync
 * 0.7.2 — CREATE TRIGGER / CREATE VIEW stay local; pull DOES bring cloud
 * triggers/views down, and a mirrored copy on the cloud does not break later
 * pull/push).
 *
 * After a migration's push succeeds, copy the replica's trigger/view
 * definitions to the cloud primary verbatim (same `sqlite_master.sql`), and
 * drop the ones this migration dropped.
 *
 * Triggers fire on BOTH copies: a device write fires the device trigger (its
 * rows sync up) and the replayed write fires the cloud trigger again. Only
 * triggers that are safe to run twice are copied (writes via INSERT OR IGNORE /
 * OR REPLACE / ON CONFLICT, or no writes). Others are reported, not copied —
 * a plain INSERT trigger would double-write every device change on the cloud.
 */

import type { Client } from "@libsql/client";
import type { AppDataSource } from "../appDataSources.js";

export interface SchemaObject {
  type: "trigger" | "view";
  name: string;
  sql: string;
}

export interface MirrorPlan {
  /** Missing on the cloud, or defined differently there. */
  create: SchemaObject[];
  /** Triggers that would double-write when they also fire on the cloud. */
  unsafe: SchemaObject[];
  /** Dropped by the migration and still present on the cloud. */
  drop: Array<Pick<SchemaObject, "type" | "name">>;
}

const LIST_SQL =
  "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger','view') AND sql IS NOT NULL";

/** Platform-owned objects (sync log triggers, row-sync columns) are not ours to mirror. */
export function isPlatformSchemaObject(name: string): boolean {
  return /^(sqlite_|_papr_|_turso|turso_)/i.test(name);
}

function rowsToObjects(rows: ReadonlyArray<Record<string, unknown>>): SchemaObject[] {
  const out: SchemaObject[] = [];
  for (const row of rows) {
    const type = String(row.type ?? row[0] ?? "").toLowerCase();
    const name = String(row.name ?? row[1] ?? "");
    const sql = String(row.sql ?? row[2] ?? "");
    if ((type === "trigger" || type === "view") && name && sql && !isPlatformSchemaObject(name)) {
      out.push({ type, name, sql });
    }
  }
  return out;
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** Trigger/view names a migration drops (`DROP TRIGGER [IF EXISTS] x`). */
export function droppedSchemaObjects(
  statements: readonly string[],
): Array<Pick<SchemaObject, "type" | "name">> {
  const out: Array<Pick<SchemaObject, "type" | "name">> = [];
  const re = /^\s*DROP\s+(TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/i;
  for (const statement of statements) {
    const m = re.exec(statement);
    const name = m && (m[2] ?? m[3] ?? m[4] ?? m[5]);
    if (m && name) out.push({ type: m[1].toLowerCase() as "trigger" | "view", name });
  }
  return out;
}

/**
 * Can this trigger run on both copies without duplicating rows? Body INSERTs
 * must be OR IGNORE / OR REPLACE / REPLACE / ON CONFLICT (keyed rows), and
 * UPDATEs must not accumulate (`x = x + …`).
 */
export function isReplaySafeTrigger(sql: string): boolean {
  const body = /\bBEGIN\b([\s\S]*)\bEND\s*;?\s*$/i.exec(sql.replace(/'(?:[^']|'')*'/g, "''"))?.[1] ?? "";
  for (const statement of body.split(";")) {
    const s = statement.trim();
    if (/^INSERT\b/i.test(s) && !/^INSERT\s+OR\s+(IGNORE|REPLACE)\b/i.test(s) && !/\bON\s+CONFLICT\b/i.test(s)) {
      return false;
    }
    if (/^UPDATE\b/i.test(s)) {
      const m = /\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(s);
      for (const assign of (m?.[1] ?? "").split(",")) {
        const [lhs, rhs] = assign.split("=").map((x) => x?.trim().replace(/["`\[\]]/g, "").toLowerCase());
        if (lhs && rhs && new RegExp(`(^|[^\\w.])${lhs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(rhs)) return false;
      }
    }
  }
  return true;
}

export function planSchemaObjectMirror(
  replica: readonly SchemaObject[],
  cloud: readonly SchemaObject[],
  dropped: ReadonlyArray<Pick<SchemaObject, "type" | "name">>,
): MirrorPlan {
  const key = (o: Pick<SchemaObject, "type" | "name">) => `${o.type}:${o.name.toLowerCase()}`;
  const cloudByKey = new Map(cloud.map((o) => [key(o), o]));
  const replicaKeys = new Set(replica.map(key));
  const changed = replica.filter((o) => {
    const remote = cloudByKey.get(key(o));
    return !remote || norm(remote.sql) !== norm(o.sql);
  });
  const create = changed.filter((o) => o.type === "view" || isReplaySafeTrigger(o.sql));
  const unsafe = changed.filter((o) => !create.includes(o));
  const drop = dropped.filter((o) => !replicaKeys.has(key(o)) && cloudByKey.has(key(o)));
  return { create, unsafe, drop };
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Statements that bring the cloud in line with `plan` (views before triggers that may read them). */
export function mirrorStatements(plan: MirrorPlan): string[] {
  const statements: string[] = [];
  for (const o of plan.drop) statements.push(`DROP ${o.type.toUpperCase()} IF EXISTS ${quote(o.name)}`);
  const ordered = [...plan.create].sort((a, b) => (a.type === b.type ? 0 : a.type === "view" ? -1 : 1));
  for (const o of ordered) {
    statements.push(`DROP ${o.type.toUpperCase()} IF EXISTS ${quote(o.name)}`);
    statements.push(o.sql);
  }
  return statements;
}

/** Read the replica's trigger/view definitions (call before a push — see replicaObjects). */
export async function captureReplicaSchemaObjects(
  source: AppDataSource,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const { queryLinkedDbViaTursoReplica } = await import("./tursoReplicaRouting.js");
  return (await queryLinkedDbViaTursoReplica(source, LIST_SQL, [], { pullBeforeRead: false })).rows;
}

/**
 * Copy the replica's triggers/views to the cloud primary. Best-effort: a
 * failure is reported, never thrown — the migration itself already landed.
 */
export async function mirrorSchemaObjectsToCloud(options: {
  source: AppDataSource;
  /** Defaults to the source's mapped Turso name. */
  tursoDatabase?: string;
  statements: readonly string[];
  /**
   * Replica triggers/views captured BEFORE the push. Turso Sync's push rewinds
   * the local WAL and replays the cloud state, which has no triggers/views — so
   * reading the replica after the push finds nothing to copy.
   */
  replicaObjects?: ReadonlyArray<Record<string, unknown>>;
  deps?: {
    readReplica?: () => Promise<ReadonlyArray<Record<string, unknown>>>;
    openCloud?: () => Promise<Pick<Client, "execute" | "batch" | "close">>;
  };
}): Promise<{ created: string[]; dropped: string[]; notCopied: string[]; error: string | null }> {
  try {
    const captured = options.replicaObjects;
    const readReplica =
      (captured ? async () => captured : undefined) ??
      options.deps?.readReplica ??
      (async () => {
        const { queryLinkedDbViaTursoReplica } = await import("./tursoReplicaRouting.js");
        return (await queryLinkedDbViaTursoReplica(options.source, LIST_SQL, [], { pullBeforeRead: false })).rows;
      });
    const openCloud =
      options.deps?.openCloud ??
      (async () => {
        const { openTursoPrimaryClient } = await import("../jobs/jobMigrationTursoSync.js");
        const { resolveTursoDatabaseForReplicaSource } = await import("./tursoReplicaRouting.js");
        return openTursoPrimaryClient(
          options.tursoDatabase ?? resolveTursoDatabaseForReplicaSource(options.source),
        );
      });
    const replica = rowsToObjects(await readReplica());
    const client = await openCloud();
    try {
      const cloud = rowsToObjects((await client.execute(LIST_SQL)).rows as Record<string, unknown>[]);
      const plan = planSchemaObjectMirror(replica, cloud, droppedSchemaObjects(options.statements));
      const statements = mirrorStatements(plan);
      if (statements.length > 0) {
        await client.batch(statements, "write");
      }
      return {
        created: plan.create.map((o) => `${o.type} ${o.name}`),
        dropped: plan.drop.map((o) => `${o.type} ${o.name}`),
        notCopied: plan.unsafe.map((o) => o.name),
        error: null,
      };
    } finally {
      client.close();
    }
  } catch (error) {
    return { created: [], dropped: [], notCopied: [], error: (error as Error).message };
  }
}
