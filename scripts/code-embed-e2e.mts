// End-to-end: real papr-embed-code ONNX on device + real CodeIndexer + the memory server's code_context routes over HTTP.
//   tsx scripts/code-embed-e2e.mts <modelRoot> <serverUrl>
// Scenarios: local search, cloud sync, cloud tier (server embeds the query), rename, new file, edit, delete,
// tenant isolation, offline.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodeIndexer } from "../src/core/tools/codeEmbed/codeIndexer.js";
import { loadEmbedder } from "../src/core/tools/codeEmbed/embedder.js";
import { CodeVectorStore } from "../src/core/tools/codeEmbed/vectorStore.js";

const [modelRoot, url] = process.argv.slice(2) as [string, string];
const client = (key: string, base = url) => ({
  post: async (p: string, o: { body: unknown; timeout?: number }) => {
    const r = await fetch(base + p, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeout ?? 30_000),
    });
    if (!r.ok) throw new Error(`${p} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  },
});
const results: Array<{ step: string; ok: boolean; detail: string; ms?: number }> = [];
const check = (step: string, ok: boolean, detail: string, ms?: number) => { results.push({ step, ok, detail, ms }); console.log(`${ok ? "PASS" : "FAIL"} ${step} ${ms !== undefined ? `(${ms} ms) ` : ""}- ${detail}`); };
const timed = async <T,>(f: () => Promise<T>) => { const t = Date.now(); const v = await f(); return [v, Date.now() - t] as const; };

// A small real repo: the codeEmbed sources themselves + a few files with distinct jobs.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-e2e-"));
const root = path.join(dir, "repo");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
for (const f of ["chunker.ts", "deviceHealth.ts", "vectorStore.ts", "cloudSync.ts"])
  fs.copyFileSync(path.join("src/core/tools/codeEmbed", f), path.join(root, "src", f));
fs.writeFileSync(path.join(root, "src/invoice.ts"), "// Render a PDF invoice for a customer order with line items, tax and totals\nexport function renderInvoicePdf(order: { items: { price: number; qty: number }[]; taxRate: number }) {\n  const subtotal = order.items.reduce((s, i) => s + i.price * i.qty, 0);\n  return { subtotal, tax: subtotal * order.taxRate, total: subtotal * (1 + order.taxRate) };\n}\n");
fs.writeFileSync(path.join(root, "src/retry.ts"), "// Retry an HTTP upload with exponential backoff and jitter\nexport async function uploadWithRetry(send: () => Promise<Response>, attempts = 5) {\n  for (let i = 0; i < attempts; i++) {\n    try { const r = await send(); if (r.ok) return r; } catch {}\n    await new Promise((res) => setTimeout(res, 2 ** i * 200 + Math.random() * 100));\n  }\n  throw new Error('upload failed');\n}\n");
fs.writeFileSync(path.join(root, ".env"), "PAPR_API_KEY=secret\n");

const emb = await loadEmbedder(modelRoot);
let tier: "local" | "cloud" | "off" = "local";
let cloudUp = true;
const store = CodeVectorStore.open(path.join(dir, "code-vectors.db"), emb.model, emb.dim);
const ix = new CodeIndexer({ store, tier: () => tier, embedder: async () => emb, cloud: async () => (cloudUp ? client("ns-alice") : client("ns-alice", "http://127.0.0.1:1")) });
const top = async (q: string) => (await ix.search(q, { root, limit: 3 })).hits.map((h) => h.path);

// 1. Index + local search
const r1 = ix.refresh(root);
check("refresh skips secrets", !store.listFiles(root).some((f) => f.path === ".env"), `${r1.changed.length} files, .env skipped`);
const [e1, embMs] = await timed(() => ix.embedPending(50));
check("embed on device", e1.embedded === 6 && store.stats().pending === 0, `${e1.embedded} files embedded`, embMs);
let [hits, ms] = await timed(() => top("where do we retry a failed upload with backoff"));
check("local search: retry", hits[0] === "src/retry.ts", hits.join(", "), ms);
[hits, ms] = await timed(() => top("generate the pdf invoice totals with tax"));
check("local search: invoice", hits[0] === "src/invoice.ts", hits.join(", "), ms);
[hits, ms] = await timed(() => top("split a long file into overlapping line windows for embedding"));
check("local search: chunker", hits[0] === "src/chunker.ts", hits.join(", "), ms);

// 2. Cloud sync: vectors only
const [s1, syncMs] = await timed(() => ix.syncCloud(() => "repo-e2e"));
check("cloud sync uploads all", s1.uploaded === 6 && s1.failed === 0, JSON.stringify(s1), syncMs);
const s2 = await ix.syncCloud(() => "repo-e2e");
check("cloud sync is idempotent", s2.uploaded === 0, JSON.stringify(s2));
const stats1: any = await (await fetch(url + "/e2e/stats")).json();
check("server never embedded documents", stats1.embed_document === 0 && stats1.points === 6, JSON.stringify(stats1));

// 3. Rename: no re-embed, both tiers return the new path
fs.renameSync(path.join(root, "src/retry.ts"), path.join(root, "src/net-retry.ts"));
ix.refresh(root);
const e2 = await ix.embedPending(50);
check("rename: no re-embed", e2.embedded === 0, `embedded ${e2.embedded}`);
hits = await top("where do we retry a failed upload with backoff");
check("rename: local search returns new path", hits[0] === "src/net-retry.ts", hits.join(", "));

// 4. Cloud tier: device does not embed; server embeds the query, restricted to this device's blobs
tier = "cloud";
[hits, ms] = await timed(() => top("where do we retry a failed upload with backoff"));
check("cloud tier search (server embeds query)", hits[0] === "src/net-retry.ts", hits.join(", "), ms);
const stats2: any = await (await fetch(url + "/e2e/stats")).json();
check("cloud tier used server query embedding", stats2.embed_query >= 1, JSON.stringify(stats2));
[hits] = await timed(() => top("generate the pdf invoice totals with tax"));
check("cloud tier search: invoice", hits[0] === "src/invoice.ts", hits.join(", "));
tier = "local";

// 5. New file written by the agent: found after one background tick, then synced
fs.writeFileSync(path.join(root, "src/slugify.ts"), "// Turn a document title into a URL slug: lowercase, strip accents, dashes for spaces\nexport const slugify = (t: string) => t.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');\n");
ix.noteWrite(root, path.join(root, "src/slugify.ts"));
check("new file pending before embed", store.stats().pending === 1, `pending ${store.stats().pending}`);
const [e3, newMs] = await timed(() => ix.embedPending());
hits = await top("make a url friendly slug from a title");
check("new file found after one tick", e3.embedded === 1 && hits[0] === "src/slugify.ts", hits.join(", "), newMs);
check("new file synced", (await ix.syncCloud(() => "repo-e2e")).uploaded === 1, "uploaded 1");

// 6. Edit: stale vector never returned; fresh one after re-embed
fs.writeFileSync(path.join(root, "src/invoice.ts"), "// Parse a CSV of bank transactions into rows with date, amount and memo\nexport function parseTransactionsCsv(csv: string) {\n  return csv.trim().split('\\n').slice(1).map((l) => { const [date, amount, memo] = l.split(','); return { date, amount: Number(amount), memo }; });\n}\n");
ix.noteWrite(root, path.join(root, "src/invoice.ts"));
hits = await top("generate the pdf invoice totals with tax");
check("edit: stale vector not returned", !hits.includes("src/invoice.ts"), hits.join(", "));
await ix.embedPending();
hits = await top("parse bank transactions from a csv file");
check("edit: new content found", hits[0] === "src/invoice.ts", hits.join(", "));

// 7. Delete: orphan dropped locally and in the cloud
fs.unlinkSync(path.join(root, "src/slugify.ts"));
ix.refresh(root);
const s3 = await ix.syncCloud(() => "repo-e2e");
check("delete: orphans dropped (old invoice + slugify)", s3.dropped === 2, JSON.stringify(s3));

// 8. Tenant isolation: another account sees nothing
const bob: any = await client("ns-bob").post("/v1/memory/search", { body: { query: "retry upload", code_search: { embed_model: emb.model, limit: 10 } } });
check("tenant isolation", (bob?.data?.memories ?? []).length === 0, `bob sees ${(bob?.data?.memories ?? []).length}`);

// 9. Offline: local tier keeps working; cloud tier degrades to no hits without throwing
cloudUp = false;
hits = await top("where do we retry a failed upload with backoff");
check("offline: local search still works", hits[0] === "src/net-retry.ts", hits.join(", "));
const off = await ix.syncCloud(() => "repo-e2e");
check("offline: sync fails soft", off.failed === -1 || off.uploaded === 0, JSON.stringify(off));
tier = "cloud";
const offHits = await ix.search("retry upload", { root });
check("offline: cloud tier returns [] (grep still answers)", offHits.hits.length === 0, `tier ${offHits.tier}, ${offHits.hits.length} hits`);

await emb.close(); store.close();
const failed = results.filter((r) => !r.ok).length;
fs.writeFileSync("/tmp/code-e2e-results.json", JSON.stringify(results, null, 1));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
