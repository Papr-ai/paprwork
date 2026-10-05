/** S3b — run the migration on the cloud directly (one conditional batch), then pull locally. */
import { connect } from "@tursodatabase/sync";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
const UP = process.env.S3_URL!.replace(/^libsql:/, "https:"); const TOKEN = process.env.S3_TOKEN!;
const R = process.env.S3_RUN ?? Date.now().toString(36);
async function pipe(requests: unknown[]) {
  const r = await fetch(`${UP}/v2/pipeline`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ requests: [...requests, { type: "close" }] }) });
  return ((await r.json()) as any).results;
}
const q = async (sql: string) => { const x = (await pipe([{ type: "execute", stmt: { sql } }]))[0]; if (x.type !== "ok") return `ERR ${x.error.message}`; const { cols, rows } = x.response.result; return rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i].name, v.value ?? null]))); };
/** All-or-nothing: each step runs only if the previous one succeeded; ROLLBACK runs if any failed. */
async function migrate(stmts: string[]) {
  const all = ["BEGIN IMMEDIATE", ...stmts, "COMMIT"];
  const steps: any[] = all.map((sql, i) => ({ stmt: { sql }, ...(i > 0 ? { condition: { type: "ok", step: i - 1 } } : {}) }));
  steps.push({ stmt: { sql: "ROLLBACK" }, condition: { type: "not", cond: { type: "ok", step: all.length - 1 } } });
  const res = (await pipe([{ type: "batch", batch: { steps } }]))[0];
  const errs = res.response?.result?.step_errors?.map((e: any, i: number) => e && `${i}:${e.message}`).filter(Boolean);
  return { committed: res.response?.result?.step_results?.[all.length - 1] != null, errs };
}
const rebuild = (t: string, bad = false) => [
  `CREATE TABLE ${t}_new (id INTEGER PRIMARY KEY, price_cents INTEGER)`,
  `INSERT INTO ${t}_new SELECT id, CAST(ROUND(CAST(price AS REAL)*100) AS INTEGER) FROM ${t}`,
  `DROP TABLE ${t}`,
  bad ? `ALTER TABLE ${t}_new RENAME TO no such syntax` : `ALTER TABLE ${t}_new RENAME TO ${t}`,
  `ALTER TABLE ${t} RENAME COLUMN price_cents TO amount_cents`,
];
const tables = async (t: string) => (await q(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE '${t}%' ORDER BY name`) as any[]).map((r) => r.sql);
(async () => {
  for (const bad of [true, false]) {
    const t = `s3b_${R}_${bad ? "bad" : "ok"}`;
    await q(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, price TEXT)`); await q(`INSERT INTO ${t} VALUES (1,'12.50'),(2,'7.25')`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3b-"));
    const db = await connect({ path: path.join(dir, "l.db"), url: UP, authToken: TOKEN, clientName: "s3b" });
    await db.pull();
    await db.exec(`INSERT INTO ${t} VALUES (3,'9.99')`); // pending local row in OLD shape
    const m = await migrate(rebuild(t, bad));
    console.log(`== ${bad ? "failing statement mid-migration" : "good migration"}`, JSON.stringify(m));
    console.log("   cloud schema:", JSON.stringify(await tables(t)));
    console.log("   cloud rows:", JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`)));
    let e = ""; try { await db.push(); } catch (x) { e = (x as Error).message.slice(0, 140); }
    console.log("   push pending old-shape row:", e || "ok");
    e = ""; try { await db.pull(); } catch (x) { e = (x as Error).message.slice(0, 140); }
    console.log("   local pull:", e || "ok");
    const ls = await (await db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE '${t}%' ORDER BY name`)).all();
    console.log("   local schema:", JSON.stringify((ls as any[]).map((r) => r.sql)));
    console.log("   local rows:", JSON.stringify(await (await db.prepare(`SELECT * FROM ${t} ORDER BY id`)).all().catch((x: Error) => x.message)));
    console.log("   cloud rows final:", JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`)));
    await db.close();
  }
})();
