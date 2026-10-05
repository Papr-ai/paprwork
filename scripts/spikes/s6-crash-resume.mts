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


const crashPoints = ["afterMigrate", "afterRebuild", "afterReplay", "afterPush"] as const;
for (const crash of crashPoints) {
  const t = `s6_${R}_${crash}`;
  console.log(`=== crash ${crash}`);
  await q(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, price TEXT)`); await q(`INSERT INTO ${t} VALUES (1,'12.50')`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s6-")); const local = path.join(dir, "l.db");
  let db: any = await connect({ path: local, url: UP, authToken: TOKEN, clientName: "s6" });
  await db.pull();
  const mig = [`ALTER TABLE ${t} RENAME COLUMN price TO amount`];
  for (const s of mig) await db.exec(s);
  hold.addMigrationToHold({ localPath: local, dbId: "scratch", migration: { migrationId: `m_${crash}`, sql: mig.join(";\n"), breaking: true } });
  // two held writes: explicit id, and an implicit-id insert (would duplicate on double replay)
  const w = [{ sql: `INSERT INTO ${t} (id, amount) VALUES (?, ?)`, params: [2, "9.99"] }, { sql: `INSERT INTO ${t} (amount) VALUES (?)`, params: ["7.77"] }];
  for (const x of w) { await (await db.prepare(x.sql)).run(x.params); hold.appendHoldJournal(local, [x]); }
  const mk = (crashAt?: string) => {
    const boom = (p: string) => { if (crashAt === p) throw new Error(`CRASH ${p}`); };
    return {
      migrateCloud: async (h: any) => { const out: string[] = []; for (const m of h.migrations) if (await migrateCloudBatch(m.sql.split(";\n"), `${R}_${m.migrationId}`)) out.push(m.migrationId); boom("afterMigrate"); return out; },
      listCloudTables: async () => [sig(await q(`SELECT name FROM pragma_table_info('${t}')`), t)],
      listLocalTables: async () => [sig(await (await db.prepare(`SELECT name FROM pragma_table_info('${t}')`)).all(), t)],
      rebuildLocalFromCloud: async () => { await db.close(); for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); db = await connect({ path: local, url: UP, authToken: TOKEN, clientName: "s6b" }); await db.pull(); boom("afterRebuild"); },
      replay: async (_s: any, st: any[]) => { for (const s of st) await (await db.prepare(s.sql)).run(s.params ?? []); boom("afterReplay"); },
      push: async () => { try { await db.push(); } catch (e) { return { ok: false, error: (e as Error).message }; } boom("afterPush"); return { ok: true }; },
    };
  };
  try { await publishHeldDatabase(hold.getReplicaPublishHold(local)!, "scratch", mk(crash)); console.log("  first run: no crash?!"); }
  catch (e) { console.log("  first run:", (e as Error).message.slice(0, 120), "| held:", hold.isReplicaHeld(local)); }
  try { const r = await publishHeldDatabase(hold.getReplicaPublishHold(local)!, "scratch", mk()); console.log("  retry:", JSON.stringify(r)); }
  catch (e) { console.log("  retry FAILED:", (e as Error).message.slice(0, 200)); }
  console.log("  held after retry:", hold.isReplicaHeld(local));
  console.log("  cloud:", JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`)));
  await db.close();
}
