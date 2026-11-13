/**
 * Shadow report for papr.entities on REAL app data, without touching it.
 *
 * Copies the bound tables of an app (read-only, via the desktop gateway's
 * /api/db/query) into an in-memory SQLite, runs the same sync the gateway runs,
 * and prints what identity linking would produce. Nothing is written to the
 * app's databases or to memory.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/tsx/dist/cli.mjs \
 *     scripts/entities-shadow-report.ts <appId> [--out report.json]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest, type EntityType } from "../src/gateway/services/entities/entitiesCore.js";
import { entityForRow, syncManifest, type SqlPort } from "../src/gateway/services/entities/entitiesStore.js";

const GATEWAY = process.env.PAPR_GATEWAY_URL ?? "http://localhost:18789";
const appsDir = path.join(process.env.PAPR_HOME ?? path.join(os.homedir(), "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V"), "apps");

async function q(appId: string, sourceId: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${GATEWAY}/api/db/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId, sourceId, sql, params: [] }),
  });
  const json = (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string };
  if (!res.ok) throw new Error(`${sourceId}: ${json.error}`);
  return json.rows ?? [];
}

function port(db: Database.Database): SqlPort {
  return {
    query: async (sql, params = []) => db.prepare(sql).all(...(params as unknown[])) as Array<Record<string, unknown>>,
    run: async (sql, params = []) => void db.prepare(sql).run(...(params as unknown[])),
    exec: async (sql) => void db.exec(sql),
  };
}

async function main() {
  const appId = process.argv[2];
  const outIdx = process.argv.indexOf("--out");
  if (!appId) throw new Error("usage: entities-shadow-report.ts <appId> [--out file]");
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(appsDir, appId, "entities.json"), "utf8")));

  // One in-memory DB per source, holding copies of only the bound tables.
  const dbs = new Map<string, Database.Database>();
  const bindings = Object.values(manifest.uses).flat();
  for (const b of bindings) {
    if (!dbs.has(b!.source)) dbs.set(b!.source, new Database(":memory:"));
    const db = dbs.get(b!.source)!;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(b!.table);
    if (exists) continue;
    const rows = await q(appId, b!.source, `SELECT * FROM "${b!.table}"`);
    const cols = rows.length ? Object.keys(rows[0]!) : [b!.key];
    db.exec(`CREATE TABLE "${b!.table}" (${cols.map((c) => `"${c}"`).join(", ")})`);
    const ins = db.prepare(`INSERT INTO "${b!.table}" VALUES (${cols.map(() => "?").join(", ")})`);
    db.transaction(() => rows.forEach((r) => ins.run(...cols.map((c) => (typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : (r[c] as never))))))();
    console.error(`copied ${b!.source}.${b!.table}: ${rows.length} rows`);
  }

  const started = Date.now();
  const report = await syncManifest(async (alias) => port(dbs.get(alias)!), manifest, { limit: 20000 });
  const home = port(dbs.get(manifest.home)!);

  // A few concrete examples of cross-table links, for a human to eyeball.
  const examples: Array<Record<string, unknown>> = [];
  const shared = await home.query(
    `SELECT entity_id, COUNT(*) n, GROUP_CONCAT(source_table || ':' || source_row, ' | ') rows, MIN(via) via
       FROM _papr_entity_xref WHERE entity_id IS NOT NULL GROUP BY entity_id HAVING COUNT(DISTINCT source_table) > 1
       ORDER BY n DESC LIMIT 8`,
  );
  for (const s of shared) {
    const [e] = await home.query(`SELECT type, keys_json FROM _papr_entities WHERE entity_id = ?`, [s.entity_id]);
    examples.push({ type: e?.type, keys: JSON.parse(String(e?.keys_json ?? "{}")), rows: s.rows, via: s.via });
  }
  const conflicts = report.bindings.flatMap((b) => b.conflicts.slice(0, 5).map((c) => ({ table: b.table, type: b.type, ...c })));
  const out = {
    app: appId,
    pack: manifest.pack,
    mode: manifest.mode,
    home: manifest.home,
    ms: Date.now() - started,
    entities: report.entities,
    sharedAcrossRows: report.sharedAcrossRows,
    bindings: report.bindings.map((b) => ({ type: b.type, table: b.table, rows: b.rows, linked: b.linked, created: b.created, unmatched: b.unmatched, conflicts: b.conflicts.length })),
    crossTableExamples: examples,
    conflictExamples: conflicts,
  };
  void entityForRow; void (null as unknown as EntityType);
  const json = JSON.stringify(out, null, 2);
  if (outIdx > 0) fs.writeFileSync(process.argv[outIdx + 1]!, json);
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
