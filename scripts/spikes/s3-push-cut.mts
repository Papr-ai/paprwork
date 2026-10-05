/**
 * Spike S3 — is a migration push all-or-nothing when the connection is cut?
 * Local HTTP proxy → real Turso. For each push request index k and mode:
 *   "drop-before": abort before forwarding (server never sees it)
 *   "drop-after":  forward fully, then kill the response (server applied, client sees error)
 * Then inspect cloud schema/rows, retry push through a clean proxy, inspect again.
 */
import { connect } from "@tursodatabase/sync";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

const UP = process.env.S3_URL!.replace(/^libsql:/, "https:");
const TOKEN = process.env.S3_TOKEN!;
const MODE = process.env.S3_MODE ?? "list";

async function cloud(sql: string) {
  const r = await fetch(`${UP}/v2/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql } }, { type: "close" }] }),
  });
  const j = (await r.json()) as any;
  const x = j.results[0];
  if (x.type !== "ok") return `ERR ${x.error?.message}`;
  const { cols, rows } = x.response.result;
  return rows.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i].name, v.value ?? null])));
}

let cut: { index: number; mode: string } | null = null;
let pushIdx = 0;
const seen: string[] = [];
function startProxy(): Promise<{ port: number; close: () => void }> {
  return new Promise((res) => {
    const srv = http.createServer(async (req, resp) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const isPush = req.method === "POST" && !/pull|export|info|generation/i.test(req.url ?? "");
      const myIdx = isPush ? pushIdx++ : -1;
      seen.push(`${req.method} ${req.url} ${body.length}B${isPush ? ` push#${myIdx}` : ""}`);
      if (isPush && process.env.S3_DUMP) fs.appendFileSync(process.env.S3_DUMP, `--- push#${myIdx}\n${body.toString("utf8")}\n`);
      if (cut && isPush && myIdx === cut.index && cut.mode === "drop-before") {
        req.socket.destroy();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
      try {
        const up = await fetch(UP + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : body });
        const buf = Buffer.from(await up.arrayBuffer());
        if (cut && isPush && myIdx === cut.index && cut.mode === "drop-after") {
          req.socket.destroy();
          return;
        }
        const h: Record<string, string> = {};
        up.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "content-length"].includes(k)) h[k] = v; });
        resp.writeHead(up.status, h);
        resp.end(buf);
      } catch (e) {
        req.socket.destroy();
      }
    });
    srv.listen(0, "127.0.0.1", () => res({ port: (srv.address() as any).port, close: () => srv.close() }));
  });
}

const MIG = (t: string) => process.env.S3_MIG === "simple" ? [
  `ALTER TABLE ${t} ADD COLUMN currency TEXT DEFAULT 'USD'`,
  `ALTER TABLE ${t} RENAME COLUMN price TO amount`,
  `CREATE TABLE ${t}_audit (id INTEGER PRIMARY KEY, note TEXT)`,
  `INSERT INTO ${t}_audit VALUES (1,'migrated')`,
  `UPDATE ${t} SET currency='EUR' WHERE id=2`,
] : [
  `CREATE TABLE ${t}_new (id INTEGER PRIMARY KEY, price_cents INTEGER)`,
  `INSERT INTO ${t}_new SELECT id, CAST(ROUND(CAST(price AS REAL)*100) AS INTEGER) FROM ${t}`,
  `DROP TABLE ${t}`,
  `ALTER TABLE ${t}_new RENAME TO ${t}`,
  `CREATE TABLE ${t}_audit (id INTEGER PRIMARY KEY, note TEXT)`,
  `INSERT INTO ${t}_audit VALUES (1,'migrated')`,
];

async function runCase(t: string, c: { index: number; mode: string } | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-"));
  await cloud(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, price TEXT)`);
  await cloud(`INSERT INTO ${t} VALUES (1,'12.50'),(2,'7.25')`);
  const px = await startProxy();
  const db = await connect({ path: path.join(dir, "l.db"), url: `http://127.0.0.1:${px.port}`, authToken: TOKEN, clientName: "s3" });
  await db.pull();
  for (const s of MIG(t)) await db.exec(s);
  seen.length = 0; pushIdx = 0; cut = c;
  let pushErr = "";
  try { await db.push(); } catch (e) { pushErr = (e as Error).message.slice(0, 160); }
  const reqs = [...seen];
  const schema = `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '${t}%' ORDER BY name`;
  const afterCut = { tables: (await cloud(schema) as any[]).map?.((r) => r.name), rows: await cloud(`SELECT * FROM ${t} ORDER BY id`) };
  cut = null;
  let retryErr = "";
  try { await db.push(); } catch (e) { retryErr = (e as Error).message.slice(0, 160); }
  const afterRetry = { tables: (await cloud(schema) as any[]).map?.((r) => r.name), rows: await cloud(`SELECT * FROM ${t} ORDER BY id`) };
  await db.close(); px.close();
  return { t, cut: c, pushReqs: reqs, pushErr, afterCut, retryErr, afterRetry };
}

(async () => {
  const run = process.env.S3_RUN ?? Date.now().toString(36);
  if (MODE === "list") {
    console.log(JSON.stringify(await runCase(`s3l_${run}`, null), null, 1));
    return;
  }
  const n = Number(process.env.S3_N ?? 1);
  let i = 0;
  for (const mode of ["drop-before", "drop-after"]) for (let k = 0; k < n; k++) {
    console.log(JSON.stringify(await runCase(`s3_${run}_${i++}`, { index: k, mode })));
  }
})();
