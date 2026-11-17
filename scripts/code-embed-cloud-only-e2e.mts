// End-to-end, laptop off: a cloud-tier device (no model) indexes a repo by sending chunk text; memory embeds it with
// papr-embed-code-1-0.6b on its server path (Vertex fp32 in production); search is server-embedded too.
//   tsx scripts/code-embed-cloud-only-e2e.mts <tokenizerRoot> <serverUrl>
// Also checks the mixed case: vectors a Mac uploaded (laptop on) are found by a cloud-only search, and the reverse.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodeIndexer } from "../src/core/tools/codeEmbed/codeIndexer.js";
import { loadEmbedder, loadTokenCounter } from "../src/core/tools/codeEmbed/embedder.js";
import { CodeVectorStore } from "../src/core/tools/codeEmbed/vectorStore.js";

const [modelRoot, url] = process.argv.slice(2) as [string, string];
const client = (key: string) => ({
  post: async (p: string, o: { body: unknown; timeout?: number }) => {
    const r = await fetch(url + p, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeout ?? 60_000),
    });
    if (!r.ok) throw new Error(`${p} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  },
});
const stats = async () => (await fetch(url + "/e2e/stats")).json() as Promise<any>;
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const check = (step: string, ok: boolean, detail: string) => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step} - ${detail}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-cloud-e2e-"));
const mk = (name: string) => { const r = path.join(dir, name); fs.mkdirSync(path.join(r, "src"), { recursive: true }); return r; };
const clone = mk("clone"); // what the cloud agent checked out
for (const f of ["chunker.ts", "deviceHealth.ts", "vectorStore.ts", "cloudSync.ts"]) fs.copyFileSync(path.join("src/core/tools/codeEmbed", f), path.join(clone, "src", f));
fs.writeFileSync(path.join(clone, "src/invoice.ts"), "// Render a PDF invoice for a customer order with line items, tax and totals\nexport function renderInvoicePdf(order: { items: { price: number; qty: number }[]; taxRate: number }) {\n  const subtotal = order.items.reduce((s, i) => s + i.price * i.qty, 0);\n  return { subtotal, tax: subtotal * order.taxRate, total: subtotal * (1 + order.taxRate) };\n}\n");
fs.writeFileSync(path.join(clone, "src/retry.ts"), "// Retry an HTTP upload with exponential backoff and jitter\nexport async function uploadWithRetry(send: () => Promise<Response>, attempts = 5) {\n  for (let i = 0; i < attempts; i++) {\n    try { const r = await send(); if (r.ok) return r; } catch {}\n    await new Promise((res) => setTimeout(res, 2 ** i * 200 + Math.random() * 100));\n  }\n  throw new Error('upload failed');\n}\n");
fs.writeFileSync(path.join(clone, ".env"), "PAPR_API_KEY=secret\n");

// ---- B. Laptop off: cloud-only device, no model, tokenizer only ----
const count = await loadTokenCounter(modelRoot);
const cstore = CodeVectorStore.open(path.join(dir, "cloud.db"), "papr-embed-code-1-0.6b", 1024);
let noModel = 0;
const cloudIx = new CodeIndexer({ store: cstore, tier: () => "cloud", embedder: async () => { noModel++; return null; }, tokenCounter: async () => count, cloud: async () => client("ns-carol") });
const top = async (ix: CodeIndexer, q: string, root: string) => (await ix.search(q, { root, limit: 3 })).hits.map((h) => h.path);

cloudIx.refresh(clone);
check("cloud-only: secrets skipped", !cstore.listFiles(clone).some((f) => f.path === ".env"), `${cstore.listFiles(clone).length} files`);
let t = Date.now();
const i1 = await cloudIx.indexInCloud(() => "repo-cloud");
const st1 = await stats();
check("cloud-only: files sent as text, server embedded them", i1.files === 6 && i1.failed === 0 && st1.embed_document >= 6, `${JSON.stringify(i1)} server ${JSON.stringify(st1)} ${Date.now() - t} ms`);
check("cloud-only: no model loaded on this machine", noModel === 0 && cstore.stats().chunks === 0, `embedder calls ${noModel}, local vectors ${cstore.stats().chunks}`);
const i2 = await cloudIx.indexInCloud(() => "repo-cloud");
check("cloud-only: second pass sends nothing", i2.files === 0, JSON.stringify(i2));
t = Date.now();
let hits = await top(cloudIx, "where do we retry a failed upload with backoff", clone);
check("cloud-only search: retry", hits[0] === "src/retry.ts", `${hits.join(", ")} (${Date.now() - t} ms)`);
hits = await top(cloudIx, "render a pdf invoice with tax", clone);
check("cloud-only search: invoice", hits[0] === "src/invoice.ts", hits.join(", "));
hits = await top(cloudIx, "split a file into line-aligned chunks that fit the token budget", clone);
check("cloud-only search: chunker", hits[0] === "src/chunker.ts", hits.join(", "));

// Agent edit in the clone: new content is sent once and found; the old blob is no longer returned
fs.writeFileSync(path.join(clone, "src/slugify.ts"), "// Turn a title into a URL slug: lowercase, strip accents, dashes between words\nexport const slugify = (s: string) => s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');\n");
cloudIx.noteWrite(clone, path.join(clone, "src/slugify.ts"));
const i3 = await cloudIx.indexInCloud(() => "repo-cloud");
hits = await top(cloudIx, "make a url slug from a title", clone);
check("cloud-only: agent's new file indexed and found", i3.files === 1 && hits[0] === "src/slugify.ts", `${JSON.stringify(i3)} -> ${hits.join(", ")}`);

// ---- A meets B: a Mac (laptop on) uploads its own vectors; the cloud-only agent finds them, and vice versa ----
const emb = await loadEmbedder(modelRoot);
const mac = mk("mac");
fs.writeFileSync(path.join(mac, "src/geo.ts"), "// Distance in kilometres between two latitude/longitude points (haversine formula)\nexport function haversineKm(a: [number, number], b: [number, number]) {\n  const R = 6371, r = (d: number) => (d * Math.PI) / 180;\n  const dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);\n  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;\n  return 2 * R * Math.asin(Math.sqrt(h));\n}\n");
fs.copyFileSync(path.join(clone, "src/retry.ts"), path.join(mac, "src/retry.ts")); // same blob as the cloud already embedded
const mstore = CodeVectorStore.open(path.join(dir, "mac.db"), emb.model, emb.dim);
const macIx = new CodeIndexer({ store: mstore, tier: () => "local", embedder: async () => emb, cloud: async () => client("ns-carol") });
macIx.refresh(mac);
await macIx.embedPending(10);
const before = (await stats()).embed_document;
const s1 = await macIx.syncCloud(() => "repo-mac");
const after = (await stats()).embed_document;
check("laptop on: Mac uploads only what the cloud lacks (shared blob skipped)", s1.uploaded === 1 && s1.failed === 0, JSON.stringify(s1));
check("laptop on: server did not re-embed the Mac's vectors", after === before, `server document embeds ${before} -> ${after}`);
// cloud-only search over the Mac's tree (same tenant): finds the Mac-embedded geo.ts
cloudIx.refresh(mac);
hits = await top(cloudIx, "great-circle distance between two coordinates", mac);
check("mixed: cloud-only search finds a Mac-embedded file", hits[0] === "src/geo.ts", hits.join(", "));
// local search on the Mac finds the same thing with its own vectors
hits = (await macIx.search("great-circle distance between two coordinates", { root: mac, limit: 3 })).hits.map((h) => h.path);
check("mixed: local search agrees", hits[0] === "src/geo.ts", hits.join(", "));

// Tenant isolation for server-embedded rows
const other: any = await client("ns-dave").post("/v1/memory/search", { body: { query: "retry upload", code_search: { embed_model: "papr-embed-code-1-0.6b", limit: 10 } } });
check("tenant isolation (server-embedded rows)", (other?.data?.memories ?? []).length === 0, `dave sees ${(other?.data?.memories ?? []).length}`);

await emb.close(); cstore.close(); mstore.close();
const failed = results.filter((r) => !r.ok).length;
fs.writeFileSync("/tmp/code-cloud-e2e-results.json", JSON.stringify({ server: await stats(), results }, null, 1));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
