/**
 * Spike S2 — pull cloud rows onto a local replica that holds an UNPUSHED breaking migration.
 *
 * Simulates: local applies rename/drop (held, not pushed) → old live web app keeps writing
 * old-shape rows to the cloud → local pulls. Then: lift hold, push, check cloud state.
 *
 * Requires a local sqld on 127.0.0.1:8089 (fresh namespace per case via unique path —
 * sqld default namespace is shared, so each case uses its own table names).
 */
import { connect } from "@tursodatabase/sync";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const URL = (process.env.S2_URL ?? "http://127.0.0.1:8089").replace(/^libsql:/, "https:");
const TOKEN = process.env.S2_TOKEN ?? "";
const RUN = process.env.S2_RUN ?? Date.now().toString(36);
const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function cloud(sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${URL}/v2/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args: args.map(toArg) } }, { type: "close" }] }),
  });
  const json = (await res.json()) as any;
  const r = json.results[0];
  if (r.type !== "ok") throw new Error(`cloud: ${r.error?.message ?? JSON.stringify(r)}`);
  const { cols, rows } = r.response.result;
  return rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i].name, v.value ?? null])));
}
function toArg(v: unknown) {
  if (v === null) return { type: "null" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  return { type: "text", value: String(v) };
}

interface Case {
  name: string;
  setup: string[];                 // cloud + local initial schema/rows (applied on cloud, then local pulls)
  breaking: string[];              // applied LOCALLY only (held)
  localWritesAfter: string[];      // new-shape local writes while held
  cloudWritesWhileHeld: string[];  // old live app keeps writing old shape to cloud
  verifyLocal: string;
}

const t = (s: string) => s.replace(/\b(rc|dc|dt|tr_new|tr)\b/g, (m) => `${m}_${RUN}`).replace(/name='(rc|dc|dt|tr)_[a-z0-9]+'/g, (m) => m);
const cases: Case[] = [
  {
    name: "rename column",
    setup: [t("CREATE TABLE rc (id INTEGER PRIMARY KEY, name TEXT)"), t("INSERT INTO rc VALUES (1,'Ann')")],
    breaking: [t("ALTER TABLE rc RENAME COLUMN name TO full_name")],
    localWritesAfter: [t("INSERT INTO rc (id, full_name) VALUES (3,'Cat-local')")],
    cloudWritesWhileHeld: [t("INSERT INTO rc (id, name) VALUES (2,'Bob-cloud')"), t("UPDATE rc SET name='Ann2' WHERE id=1")],
    verifyLocal: t("SELECT * FROM rc ORDER BY id"),
  },
  {
    name: "drop column",
    setup: [t("CREATE TABLE dc (id INTEGER PRIMARY KEY, name TEXT, legacy TEXT)"), t("INSERT INTO dc VALUES (1,'Ann','x')")],
    breaking: [t("ALTER TABLE dc DROP COLUMN legacy")],
    localWritesAfter: [t("INSERT INTO dc (id, name) VALUES (3,'Cat-local')")],
    cloudWritesWhileHeld: [t("INSERT INTO dc (id, name, legacy) VALUES (2,'Bob-cloud','y')")],
    verifyLocal: t("SELECT * FROM dc ORDER BY id"),
  },
  {
    name: "drop table",
    setup: [t("CREATE TABLE dt (id INTEGER PRIMARY KEY, name TEXT)"), t("INSERT INTO dt VALUES (1,'Ann')")],
    breaking: [t("DROP TABLE dt")],
    localWritesAfter: [],
    cloudWritesWhileHeld: [t("INSERT INTO dt (id, name) VALUES (2,'Bob-cloud')")],
    verifyLocal: `SELECT name FROM sqlite_master WHERE name='dt_${RUN}'`,
  },
  {
    name: "table rebuild (type change)",
    setup: [t("CREATE TABLE tr (id INTEGER PRIMARY KEY, price TEXT)"), t("INSERT INTO tr VALUES (1,'12.50')")],
    breaking: [
      t("CREATE TABLE tr_new (id INTEGER PRIMARY KEY, price_cents INTEGER)"),
      t("INSERT INTO tr_new SELECT id, CAST(ROUND(CAST(price AS REAL)*100) AS INTEGER) FROM tr"),
      t("DROP TABLE tr"),
      t("ALTER TABLE tr_new RENAME TO tr"),
    ],
    localWritesAfter: [t("INSERT INTO tr (id, price_cents) VALUES (3, 999)")],
    cloudWritesWhileHeld: [t("INSERT INTO tr (id, price) VALUES (2,'7.25')")],
    verifyLocal: t("SELECT * FROM tr ORDER BY id"),
  },
];

async function runCase(c: Case) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2-"));
  const log: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { const r = await fn(); log.push(`  ok   ${label}${r !== undefined ? " → " + JSON.stringify(r) : ""}`); return r; }
    catch (e) { log.push(`  FAIL ${label} → ${(e as Error).message.slice(0, 220)}`); return undefined; }
  };
  for (const s of c.setup) await cloud(s);
  const db = await connect({ path: path.join(dir, "local.db"), url: URL, authToken: TOKEN || undefined, clientName: "s2" });
  await step("initial pull", () => db.pull());
  for (const s of c.breaking) await step(`local breaking: ${s}`, () => db.exec(s));
  for (const s of c.localWritesAfter) await step(`local write: ${s}`, () => db.exec(s));
  for (const s of c.cloudWritesWhileHeld) await step(`cloud (old app) write: ${s}`, () => cloud(s));
  const schema = () => db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE '%_${RUN}' ORDER BY name`).then((st: any) => st.all()).then((r: any[]) => r.map((x) => x.sql));
  const cloudSchema = () => cloud(`SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE '%_${RUN}' ORDER BY name`).then((r) => r.map((x) => x.sql));
  await step("local schema before pull", schema);
  await step("PULL while held", () => db.pull());
  await step("local schema after pull", schema);
  await step("local state after pull", async () => (await db.prepare(c.verifyLocal)).all());
  await step("PUSH (hold lifted)", () => db.push());
  await step("cloud state after push", () => cloud(c.verifyLocal));
  await step("cloud schema after push", cloudSchema);
  await step("second pull (converged?)", () => db.pull());
  await step("local state final", async () => (await db.prepare(c.verifyLocal)).all());
  await db.close();
  console.log(`\n=== ${c.name}\n${log.join("\n")}`);
}

(async () => {
  for (const c of cases) await runCase(c);
})();
