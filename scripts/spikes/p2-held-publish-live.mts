/**
 * Phase 2 live check: real publishHeldDatabase + hold module, real Turso, real
 * @tursodatabase/sync replica. Gateway-only deps replaced with direct equivalents.
 */
import { connect } from "@tursodatabase/sync";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
const UP = process.env.S3_URL!.replace(/^libsql:/, "https:"); const TOKEN = process.env.S3_TOKEN!;
const R = process.env.S3_RUN ?? Date.now().toString(36);
process.env.PAPR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "p2home-"));
const hold = await import("../../src/gateway/services/tursoReplica/replicaPublishHold.ts");
const { publishHeldDatabase } = await import("../../src/gateway/services/tursoReplica/publishHeldDatabases.ts");

async function pipe(requests: unknown[]) {
  const r = await fetch(`${UP}/v2/pipeline`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ requests: [...requests, { type: "close" }] }) });
  return ((await r.json()) as any).results;
}
const q = async (sql: string) => { const x = (await pipe([{ type: "execute", stmt: { sql } }]))[0]; if (x.type !== "ok") throw new Error(x.error.message); const { cols, rows } = x.response.result; return rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i].name, v.value ?? null]))); };
async function migrateCloudBatch(stmts: string[], id: string) {
  const done = await q(`SELECT id FROM _p2_ledger WHERE id='${id}'`).catch(() => []);
  if (done.length) return false;
  const all = ["BEGIN IMMEDIATE", "CREATE TABLE IF NOT EXISTS _p2_ledger (id TEXT PRIMARY KEY)", ...stmts, `INSERT INTO _p2_ledger VALUES ('${id}')`, "COMMIT"];
  const steps: any[] = all.map((sql, i) => ({ stmt: { sql }, ...(i > 0 ? { condition: { type: "ok", step: i - 1 } } : {}) }));
  steps.push({ stmt: { sql: "ROLLBACK" }, condition: { type: "not", cond: { type: "ok", step: all.length - 1 } } });
  const res = (await pipe([{ type: "batch", batch: { steps } }]))[0];
  const errs = (res.response?.result?.step_errors ?? []).filter(Boolean);
  if (errs.length) throw new Error(`cloud migration rolled back: ${errs[0].message}`);
  return true;
}
const sig = (rows: any[], t: string) => `${t}(${rows.map((r) => r.name).sort().join(",")})`;

const cases: Record<string, (t: string) => { mig: string[]; held: string }> = {
  rename_column: (t) => ({ mig: [`ALTER TABLE ${t} RENAME COLUMN price TO amount`], held: `INSERT INTO ${t} (id, amount) VALUES (?, ?)` }),
  rebuild: (t) => ({
    mig: [`CREATE TABLE ${t}_new (id INTEGER PRIMARY KEY, price_cents INTEGER)`, `INSERT INTO ${t}_new SELECT id, CAST(ROUND(CAST(price AS REAL)*100) AS INTEGER) FROM ${t}`, `DROP TABLE ${t}`, `ALTER TABLE ${t}_new RENAME TO ${t}`],
    held: `INSERT INTO ${t} (id, price_cents) VALUES (?, ?)`,
  }),
};

for (const [name, mk] of Object.entries(cases)) {
  const t = `p2_${R}_${name}`; const { mig, held } = mk(t);
  console.log(`=== ${name}`);
  await q(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, price TEXT)`); await q(`INSERT INTO ${t} VALUES (1,'12.50')`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-")); const local = path.join(dir, "l.db");
  let db: any = await connect({ path: local, url: UP, authToken: TOKEN, clientName: "p2" });
  await db.pull();
  await db.exec(`INSERT INTO ${t} VALUES (2,'3.00')`); await db.push(); // pre-hold row, uploaded
  // Phase 1: breaking migration applied locally + held; then a held-period write (journaled)
  for (const s of mig) await db.exec(s);
  hold.addMigrationToHold({ localPath: local, dbId: "scratch", migration: { migrationId: `m_${name}`, sql: mig.join(";\n"), breaking: true } });
  const heldParams = name === "rebuild" ? [3, 999] : [3, "9.99"];
  await (await db.prepare(held)).run(heldParams); hold.appendHoldJournal(local, [{ sql: held, params: heldParams }]);
  console.log("  held? sync skipped:", hold.shouldSkipSyncForHold(local), "| journal:", hold.readHoldJournal(local).length);
  console.log("  cloud before publish:", JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`)));

  const result = await publishHeldDatabase(hold.getReplicaPublishHold(local)!, "scratch", {
    migrateCloud: async (h) => { const out: string[] = []; for (const m of h.migrations) if (await migrateCloudBatch(m.sql.split(";\n"), `${R}_${m.migrationId}`)) out.push(m.migrationId); return out; },
    listCloudTables: async () => [sig(await q(`SELECT name FROM pragma_table_info('${t}')`), t)],
    listLocalTables: async () => [sig(await (await db.prepare(`SELECT name FROM pragma_table_info('${t}')`)).all(), t)],
    rebuildLocalFromCloud: async () => { await db.close(); for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); db = await connect({ path: local, url: UP, authToken: TOKEN, clientName: "p2b" }); await db.pull(); },
    replay: async (_s, st) => { for (const s of st) await (await db.prepare(s.sql)).run(s.params ?? []); },
    push: async () => { try { await db.push(); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
  });
  console.log("  publish:", JSON.stringify(result), "| still held:", hold.isReplicaHeld(local));
  console.log("  cloud after:", JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`)));
  console.log("  local after:", JSON.stringify(await (await db.prepare(`SELECT * FROM ${t} ORDER BY id`)).all()));
  // Re-run is a no-op on the cloud (ledger) — simulate a crashed-then-retried publish
  console.log("  retry migrate is no-op:", !(await migrateCloudBatch(mig, `${R}_m_${name}`)));
  await db.close();
}
