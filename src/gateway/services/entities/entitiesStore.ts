/**
 * papr.entities store: platform tables + resolve / sync / get / observe.
 *
 * All SQL goes through an injected port so the same code runs on the desktop
 * gateway (DbRouter), the cloud host, and in tests (better-sqlite3 in memory).
 * The app's own tables are only ever READ; we write to _papr_ tables only.
 */
import {
  EntitiesError,
  keysFromRow,
  matchEntity,
  mergeKeys,
  newEntityId,
  type Candidate,
  type EntitiesManifest,
  type EntityBinding,
  type EntityKeys,
  type EntityType,
} from "./entitiesCore.js";

export interface SqlPort {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
}

/** Writes graph facts. Shadow mode never calls this. */
export interface GraphPort {
  observe(input: ObserveInput & { entities: Array<{ type: EntityType; entityId: string; keys: EntityKeys }> }): Promise<{ memoryId: string | null }>;
}

export const PLATFORM_DDL = [
  `CREATE TABLE IF NOT EXISTS _papr_entities (
     entity_id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     keys_json TEXT NOT NULL DEFAULT '{}',
     facts_json TEXT NOT NULL DEFAULT '{}',
     graph_node_id TEXT,
     pack TEXT,
     synced_at TEXT,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS _papr_entities_type ON _papr_entities(type)`,
  `CREATE TABLE IF NOT EXISTS _papr_entity_xref (
     source_table TEXT NOT NULL,
     source_row TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     entity_id TEXT,
     confidence REAL NOT NULL DEFAULT 0,
     via TEXT,
     conflict TEXT,
     legacy_json TEXT NOT NULL DEFAULT '{}',
     resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     PRIMARY KEY (source_table, source_row, entity_type)
   )`,
  `CREATE INDEX IF NOT EXISTS _papr_entity_xref_entity ON _papr_entity_xref(entity_id)`,
];

export async function ensurePlatformTables(db: SqlPort): Promise<void> {
  for (const ddl of PLATFORM_DDL) await db.exec(ddl);
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function loadCandidates(db: SqlPort, type: EntityType): Promise<Candidate[]> {
  const rows = await db.query(`SELECT entity_id, keys_json FROM _papr_entities WHERE type = ?`, [type]);
  return rows.map((r) => ({ entityId: String(r.entity_id), keys: JSON.parse(String(r.keys_json || "{}")) as EntityKeys }));
}

export interface SyncReport {
  type: EntityType;
  table: string;
  rows: number;
  linked: number;
  created: number;
  conflicts: Array<{ row: string; reason: string }>;
  unmatched: number;
}

/**
 * Resolve every row of one binding into _papr_entities / _papr_entity_xref.
 * Idempotent: re-running keeps the same entity ids.
 */
export async function syncBinding(
  db: SqlPort,
  type: EntityType,
  binding: EntityBinding,
  opts: { pack: string; limit?: number; rowsDb?: SqlPort },
): Promise<SyncReport> {
  await ensurePlatformTables(db);
  const cols = new Set([binding.key, ...Object.values(binding.match), ...Object.values(binding.facts ?? {}), ...(binding.legacyIds ?? [])]);
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 20000);
  const rows = await (opts.rowsDb ?? db).query(
    `SELECT ${[...cols].map(quote).join(", ")} FROM ${quote(binding.table)} LIMIT ${limit}`,
  );
  const candidates = await loadCandidates(db, type);
  const report: SyncReport = { type, table: binding.table, rows: rows.length, linked: 0, created: 0, conflicts: [], unmatched: 0 };

  for (const row of rows) {
    const rowId = row[binding.key];
    if (rowId === null || rowId === undefined || rowId === "") continue;
    const keys = keysFromRow(type, binding, row);
    const facts: Record<string, unknown> = {};
    for (const [fact, col] of Object.entries(binding.facts ?? {})) if (row[col] !== null && row[col] !== undefined && row[col] !== "") facts[fact] = row[col];
    const legacy: Record<string, unknown> = {};
    for (const col of binding.legacyIds ?? []) if (row[col] !== null && row[col] !== undefined && row[col] !== "") legacy[col] = row[col];

    if (!Object.keys(keys).length) {
      report.unmatched++;
      await upsertXref(db, binding.table, String(rowId), type, null, 0, null, "no match keys on row", legacy);
      continue;
    }
    const m = matchEntity(type, keys, candidates);
    if (m.conflict) {
      report.conflicts.push({ row: String(rowId), reason: m.conflict });
      await upsertXref(db, binding.table, String(rowId), type, null, 0, null, m.conflict, legacy);
      continue;
    }
    let entityId = m.entityId;
    if (entityId) {
      const cand = candidates.find((c) => c.entityId === entityId)!;
      cand.keys = mergeKeys(cand.keys, keys);
      await mergeEntity(db, entityId, cand.keys, facts);
      report.linked++;
    } else {
      entityId = newEntityId(type, keys);
      while (candidates.some((c) => c.entityId === entityId)) entityId = `${entityId}x`;
      await db.run(
        `INSERT INTO _papr_entities (entity_id, type, keys_json, facts_json, pack) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO NOTHING`,
        [entityId, type, JSON.stringify(keys), JSON.stringify(facts), opts.pack],
      );
      candidates.push({ entityId, keys });
      report.created++;
    }
    await upsertXref(db, binding.table, String(rowId), type, entityId, m.entityId ? m.confidence : 1, m.via ?? "new", null, legacy);
  }
  return report;
}

async function mergeEntity(db: SqlPort, entityId: string, keys: EntityKeys, facts: Record<string, unknown>): Promise<void> {
  const [row] = await db.query(`SELECT facts_json FROM _papr_entities WHERE entity_id = ?`, [entityId]);
  const existing = JSON.parse(String(row?.facts_json || "{}")) as Record<string, unknown>;
  const merged = { ...existing };
  for (const [k, v] of Object.entries(facts)) if (merged[k] === undefined || merged[k] === null || merged[k] === "") merged[k] = v;
  await db.run(
    `UPDATE _papr_entities SET keys_json = ?, facts_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_id = ?`,
    [JSON.stringify(keys), JSON.stringify(merged), entityId],
  );
}

async function upsertXref(
  db: SqlPort, table: string, rowId: string, type: EntityType, entityId: string | null,
  confidence: number, via: string | null, conflict: string | null, legacy: Record<string, unknown>,
): Promise<void> {
  await db.run(
    `INSERT INTO _papr_entity_xref (source_table, source_row, entity_type, entity_id, confidence, via, conflict, legacy_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_table, source_row, entity_type) DO UPDATE SET
       entity_id = excluded.entity_id, confidence = excluded.confidence, via = excluded.via,
       conflict = excluded.conflict, legacy_json = excluded.legacy_json,
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [table, rowId, type, entityId, confidence, via, conflict, JSON.stringify(legacy)],
  );
}

export interface EntityView {
  entityId: string;
  type: EntityType;
  keys: EntityKeys;
  facts: Record<string, unknown>;
  graphNodeId: string | null;
  syncedAt: string | null;
  rows: Array<{ table: string; row: string; confidence: number; via: string | null; legacy: Record<string, unknown> }>;
}

export async function resolveKeys(db: SqlPort, type: EntityType, keys: EntityKeys): Promise<{ entityId: string | null; confidence: number; via: string | null; conflict?: string }> {
  await ensurePlatformTables(db);
  return matchEntity(type, keys, await loadCandidates(db, type));
}

export async function getEntity(db: SqlPort, entityId: string): Promise<EntityView | null> {
  await ensurePlatformTables(db);
  const [e] = await db.query(`SELECT * FROM _papr_entities WHERE entity_id = ?`, [entityId]);
  if (!e) return null;
  const xrefs = await db.query(
    `SELECT source_table, source_row, confidence, via, legacy_json FROM _papr_entity_xref WHERE entity_id = ? ORDER BY source_table, source_row`,
    [entityId],
  );
  return {
    entityId,
    type: e.type as EntityType,
    keys: JSON.parse(String(e.keys_json || "{}")),
    facts: JSON.parse(String(e.facts_json || "{}")),
    graphNodeId: (e.graph_node_id as string) ?? null,
    syncedAt: (e.synced_at as string) ?? null,
    rows: xrefs.map((x) => ({
      table: String(x.source_table), row: String(x.source_row), confidence: Number(x.confidence),
      via: (x.via as string) ?? null, legacy: JSON.parse(String(x.legacy_json || "{}")),
    })),
  };
}

/** Entity for one of the app's own rows (e.g. investor_review.outreach_id = 'o_12'). */
export async function entityForRow(db: SqlPort, table: string, row: string, type?: EntityType): Promise<EntityView | null> {
  await ensurePlatformTables(db);
  const params: unknown[] = [table, row];
  let sql = `SELECT entity_id FROM _papr_entity_xref WHERE source_table = ? AND source_row = ? AND entity_id IS NOT NULL`;
  if (type) {
    sql += ` AND entity_type = ?`;
    params.push(type);
  }
  const [x] = await db.query(sql + ` LIMIT 1`, params);
  return x ? getEntity(db, String(x.entity_id)) : null;
}

export interface MatchReport {
  pack: string;
  mode: "shadow" | "live";
  bindings: SyncReport[];
  entities: Record<string, number>;
  /** Entities referenced by more than one app row: the cross-table identity we gained. */
  sharedAcrossRows: number;
}

/**
 * Resolve every binding. Identity lives in the manifest's home source; rows are
 * read from each binding's own source, so tables in different DBs still link.
 */
export async function syncManifest(
  dbFor: (sourceAlias: string) => Promise<SqlPort>,
  manifest: EntitiesManifest,
  opts: { limit?: number } = {},
): Promise<MatchReport> {
  const db = await dbFor(manifest.home);
  const bindings: SyncReport[] = [];
  // Strong-key tables first so name-only rows (e.g. review rows without email) link to them.
  const ordered = (Object.entries(manifest.uses) as Array<[EntityType, EntityBinding[]]>).flatMap(([type, list]) =>
    list.map((b) => ({ type, b, strong: Object.keys(b.match).some((k) => k !== "name") })),
  );
  ordered.sort((x, y) => Number(y.strong) - Number(x.strong));
  for (const { type, b } of ordered) {
    const rowsDb = b.source === manifest.home ? db : await dbFor(b.source);
    bindings.push(await syncBinding(db, type, b, { pack: manifest.pack, limit: opts.limit, rowsDb }));
  }
  const counts = await db.query(`SELECT type, COUNT(*) AS n FROM _papr_entities GROUP BY type`);
  const [shared] = await db.query(
    `SELECT COUNT(*) AS n FROM (SELECT entity_id FROM _papr_entity_xref WHERE entity_id IS NOT NULL GROUP BY entity_id HAVING COUNT(*) > 1)`,
  );
  return {
    pack: manifest.pack,
    mode: manifest.mode,
    bindings,
    entities: Object.fromEntries(counts.map((c) => [String(c.type), Number(c.n)])),
    sharedAcrossRows: Number(shared?.n ?? 0),
  };
}

export interface ObserveInput {
  /** Free text (meeting summary, note). Extracted by the pack's policy when live. */
  text?: string;
  /** Structured facts, written without an LLM. */
  facts?: Record<string, unknown>;
  /** Entities this observation is about. Either an entityId or match keys. */
  about: Array<{ type: EntityType; entityId?: string; match?: EntityKeys }>;
  /** Where it came from in the app, for provenance. */
  source?: { table?: string; row?: string };
}

export interface ObserveResult {
  mode: "shadow" | "live";
  resolved: Array<{ type: EntityType; entityId: string | null; via: string | null; conflict?: string }>;
  memoryId: string | null;
  /** What would be sent to memory. Always returned, so shadow mode is inspectable. */
  wouldWrite: { text?: string; facts?: Record<string, unknown>; entities: Array<{ type: EntityType; entityId: string; keys: EntityKeys }> };
}

export async function observe(
  db: SqlPort,
  manifest: EntitiesManifest,
  input: ObserveInput,
  graph?: GraphPort,
): Promise<ObserveResult> {
  if (!input || !Array.isArray(input.about) || !input.about.length) throw new EntitiesError("observe: about must list at least one entity");
  if (!input.text && !input.facts) throw new EntitiesError("observe: text or facts is required");
  if (input.text && input.text.length > 15000) throw new EntitiesError("observe: text is longer than 15,000 characters");
  await ensurePlatformTables(db);
  const resolved: ObserveResult["resolved"] = [];
  const entities: ObserveResult["wouldWrite"]["entities"] = [];
  for (const a of input.about) {
    let entityId = a.entityId ?? null;
    let via: string | null = entityId ? "id" : null;
    let conflict: string | undefined;
    if (!entityId && a.match) {
      const m = await resolveKeys(db, a.type, a.match);
      entityId = m.entityId;
      via = m.via;
      conflict = m.conflict;
    }
    resolved.push({ type: a.type, entityId, via, ...(conflict ? { conflict } : {}) });
    if (entityId) {
      const e = await getEntity(db, entityId);
      entities.push({ type: a.type, entityId, keys: e?.keys ?? a.match ?? {} });
    } else if (a.match) {
      entities.push({ type: a.type, entityId: newEntityId(a.type, a.match), keys: a.match });
    }
  }
  const writes = manifest.writes ?? [];
  if (manifest.mode === "live") {
    const notAllowed = input.about.find((a) => !writes.includes(a.type) && !manifest.uses[a.type]);
    if (notAllowed) throw new EntitiesError(`observe: this app does not declare ${notAllowed.type} in entities.json`, 403);
  }
  const wouldWrite = { ...(input.text ? { text: input.text } : {}), ...(input.facts ? { facts: input.facts } : {}), entities };
  if (manifest.mode === "shadow" || !graph) {
    return { mode: manifest.mode, resolved, memoryId: null, wouldWrite };
  }
  const out = await graph.observe({ ...input, entities });
  const now = new Date().toISOString();
  for (const e of entities) {
    await db.run(`UPDATE _papr_entities SET synced_at = ? WHERE entity_id = ?`, [now, e.entityId]);
  }
  return { mode: "live", resolved, memoryId: out.memoryId, wouldWrite };
}
