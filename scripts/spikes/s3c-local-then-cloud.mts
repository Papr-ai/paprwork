/** S3c — breaking migration applied LOCALLY (held), then run on cloud directly at publish. Can local rebase? */
import { connect } from "@tursodatabase/sync";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
const UP = process.env.S3_URL!.replace(/^libsql:/, "https:"); const TOKEN = process.env.S3_TOKEN!;
const R = process.env.S3_RUN ?? Date.now().toString(36);
async function pipe(requests: unknown[]) {
  const r = await fetch(`${UP}/v2/pipeline`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ requests: [...requests, { type: "close" }] }) });
  return ((await r.json()) as any).results;
}
const q = async (sql: string) => { const x = (await pipe([{ type: "execute", stmt: { sql } }]))[0]; if (x.type !== "ok") return `ERR ${x.error.message}`; const { cols, rows } = x.response.result; return rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i].name, v.value ?? null]))); };
async function migrateCloud(stmts: string[]) {
  const all = ["BEGIN IMMEDIATE", ...stmts, "COMMIT"];
  const steps: any[] = all.map((sql, i) => ({ stmt: { sql }, ...(i > 0 ? { condition: { type: "ok", step: i - 1 } } : {}) }));
  steps.push({ stmt: { sql: "ROLLBACK" }, condition: { type: "not", cond: { type: "ok", step: all.length - 1 } } });
  await pipe([{ type: "batch", batch: { steps } }]);
}
const step = async (label: string, fn: () => Promise<unknown>) => { try { const v = await fn(); console.log(`  ok   ${label}${v === undefined ? "" : " → " + JSON.stringify(v)}`); } catch (e) { console.log(`  FAIL ${label} → ${(e as Error).message.slice(0, 160)}`); } };
const cases: Record<string, (t: string) => string[]> = {
  rename_column: (t) => [`ALTER TABLE ${t} RENAME COLUMN price TO amount`],
  rebuild: (t) => [
    `CREATE TABLE ${t}_new (id INTEGER PRIMARY KEY, price_cents INTEGER)`,
    `INSERT INTO ${t}_new SELECT id, CAST(ROUND(CAST(price AS REAL)*100) AS INTEGER) FROM ${t}`,
    `DROP TABLE ${t}`, `ALTER TABLE ${t}_new RENAME TO ${t}`,
  ],
};
(async () => {
  for (const [name, mig] of Object.entries(cases)) {
    const t = `s3c_${R}_${name}`;
    console.log(`=== ${name}`);
    await q(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, price TEXT)`); await q(`INSERT INTO ${t} VALUES (1,'12.50')`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3c-")); const p = path.join(dir, "l.db");
    let db = await connect({ path: p, url: UP, authToken: TOKEN, clientName: "s3c" });
    await db.pull();
    for (const s of mig(t)) await db.exec(s);                     // breaking DDL applied locally, held
    const journal = name === "rebuild" ? `INSERT INTO ${t} VALUES (2, 999)` : `INSERT INTO ${t} (id, amount) VALUES (2,'9.99')`;
    await db.exec(journal); // new-shape local row, also recorded in the hold journal
    await migrateCloud(mig(t));                                    // publish: cloud directly
    await step("cloud rows after direct migrate", () => q(`SELECT * FROM ${t} ORDER BY id`));
    await step("A: plain pull on top of held local DDL", () => db.pull());
    await step("A: local rows", async () => (await db.prepare(`SELECT * FROM ${t} ORDER BY id`)).all());
    await db.close();
    // B: fresh replica from cloud (discard local change log)
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
    db = await connect({ path: p, url: UP, authToken: TOKEN, clientName: "s3c2" });
    await step("B: re-bootstrap from cloud", () => db.pull());
    await step("B: local rows", async () => (await db.prepare(`SELECT * FROM ${t} ORDER BY id`)).all());
    // C: replay the journaled held-period write (new shape) onto the rebuilt copy, then push
    await step("C: replay journaled write", () => db.exec(journal));
    await step("C: push", () => db.push());
    await step("C: local rows", async () => (await db.prepare(`SELECT * FROM ${t} ORDER BY id`)).all());
    await step("C: cloud rows", () => q(`SELECT * FROM ${t} ORDER BY id`));
    await db.close();
  }
})();
