/**
 * LIVE: the real papr-embed-code-1-0.6b model on this machine, end to end through the agent's grep.
 * No fakes: real ONNX int8 weights (worker thread), real tokenizer, real CoreML helper on Apple Silicon,
 * real background indexing and executeBashCommand's hybrid grep output.
 *
 * Skipped unless the model is installed. Run:
 *   PAPR_CODE_EMBED_MODEL_ROOT=<dir containing models/papr-embed-code-1-0.6b> npm run test:code-embed:live
 * `npm run test:code-embed:live -- --download` style install: set PAPR_CODE_EMBED_LIVE_DOWNLOAD=1 to fetch the model
 * from Hugging Face into PAPR_CODE_EMBED_MODEL_ROOT first (~600 MB ONNX + tokenizer; +1.2 GB CoreML on Apple Silicon).
 * CoreML check also needs the helper: `sh native/papr-embed-coreml/build.sh` (or PAPR_CODE_EMBED_HELPER=<path>).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { downloadModel, loadEmbedder, modelInstalled, WorkerOnnxEmbedder, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";

const ROOT = process.env.PAPR_CODE_EMBED_MODEL_ROOT ?? "";
const WANT_DOWNLOAD = process.env.PAPR_CODE_EMBED_LIVE_DOWNLOAD === "1";
const live = Boolean(ROOT) && (WANT_DOWNLOAD || modelInstalled(ROOT));
const appleSilicon = process.platform === "darwin" && process.arch === "arm64";

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const norm = (a: Float32Array) => Math.sqrt(dot(a, a));

const RETRY = "async function upload(f){ for (let i=0;i<5;i++){ try { return await send(f) } catch { await sleep(2**i*200) } } }";
const SQL = "SELECT name, email FROM users WHERE created_at > now() - interval '7 days';";
const INVOICE = "export function renderInvoicePdf(order){ const doc = new PDF(); doc.text(`Invoice ${order.id}`); return doc }";

describe.skipIf(!live)("papr-embed-code-1-0.6b on this machine (live)", () => {
  let onnx: Embedder;

  beforeAll(async () => {
    if (!modelInstalled(ROOT)) await downloadModel(ROOT);
    onnx = await WorkerOnnxEmbedder.start(ROOT);
  }, 600_000);
  afterAll(async () => { await onnx?.close(); });

  test("vectors are 1024-d and unit length (pooling + normalisation correct)", async () => {
    const q = await onnx.embedQuery("retry an upload with exponential backoff");
    const [d] = await onnx.embedDocuments([RETRY]);
    expect(q.length).toBe(1024);
    expect(d!.length).toBe(1024);
    expect(Math.abs(norm(q) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(norm(d!) - 1)).toBeLessThan(1e-3);
  });

  test("retrieval sanity: each query ranks its own snippet first, by a clear margin", async () => {
    const docs = await onnx.embedDocuments([RETRY, SQL, INVOICE]);
    const cases: Array<[string, number]> = [
      ["retry an upload with exponential backoff", 0],
      ["users who signed up in the last week", 1],
      ["generate a PDF invoice for an order", 2],
    ];
    for (const [query, want] of cases) {
      const q = await onnx.embedQuery(query);
      const s = docs.map((d) => dot(q, d));
      const best = s.indexOf(Math.max(...s));
      expect(best, `${query}: scores ${s.map((x) => x.toFixed(3))}`).toBe(want);
      const second = [...s].sort((a, b) => b - a)[1]!;
      expect(s[want]! - second).toBeGreaterThan(0.1);
    }
  });

  test("worker thread and in-thread ONNX give identical vectors; the event loop stays free", async () => {
    const direct = await loadEmbedder(ROOT);
    try {
      const q = "where is the retry logic";
      expect(dot(await onnx.embedQuery(q), await direct.embedQuery(q))).toBeGreaterThan(0.9999);
    } finally {
      await direct.close();
    }
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const t = Date.now();
    await onnx.embedDocuments([RETRY.repeat(20)]);
    clearInterval(iv);
    // A blocked loop would tick ~0 times; allow scheduling slack.
    expect(ticks).toBeGreaterThan((Date.now() - t) / 10 / 3);
  });

  test("query and document lanes differ (instruction prefix applied to queries only)", async () => {
    const asQuery = await onnx.embedQuery(RETRY);
    const [asDoc] = await onnx.embedDocuments([RETRY]);
    expect(dot(asQuery, asDoc!)).toBeLessThan(0.98);
  });

  test.skipIf(!appleSilicon)("CoreML on the Neural Engine matches ONNX (cosine > 0.995)", async () => {
    const { CoreMLEmbedder, COREML_MODEL, helperPath } = await import("../../src/core/tools/codeEmbed/coremlEmbedder.js");
    const helper = process.env.PAPR_CODE_EMBED_HELPER || helperPath();
    const model = path.join(ROOT, "models", "papr-embed-code-1-0.6b", COREML_MODEL);
    if (!fs.existsSync(helper) || !fs.existsSync(model)) {
      console.warn(`[live] CoreML skipped: helper ${fs.existsSync(helper) ? "ok" : "missing"} at ${helper}; model ${fs.existsSync(model) ? "ok" : "missing"}`);
      return;
    }
    const { Tokenizer }: any = await import("@huggingface/tokenizers");
    const dir = path.join(ROOT, "models", "papr-embed-code-1-0.6b");
    const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")));
    const cml = await CoreMLEmbedder.start({ helper, modelPath: model, tok, fallback: null, timeoutMs: 15 * 60_000 });
    try {
      for (const text of [RETRY, SQL, INVOICE]) {
        const [a] = await cml.embedDocuments([text]);
        const [b] = await onnx.embedDocuments([text]);
        expect(dot(a!, b!)).toBeGreaterThan(0.995);
      }
      const t = Date.now();
      await cml.embedQuery("retry an upload with exponential backoff");
      console.log(`[live] CoreML query latency: ${Date.now() - t} ms`);
    } finally {
      await cml.close();
    }
  }, 20 * 60_000);
});

describe.skipIf(!live)("agent grep uses the on-device model (live)", () => {
  const APP_ID = "0e6b0e6b-1111-4222-8333-444455556666";
  let appDir = "";
  let rt: any;

  beforeAll(async () => {
    process.env.PAPR_CODE_EMBED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ce-live-"));
    // Share the installed model instead of copying 600 MB.
    fs.symlinkSync(path.join(ROOT, "models"), path.join(process.env.PAPR_CODE_EMBED_DATA_DIR, "models"));
    process.env.PAPR_CODE_EMBED_DOWNLOAD = "0";
    process.env.PAPR_CODE_EMBED_CLOUD_SYNC = "0";
    process.env.PAPR_CODE_EMBED_COREML = "0"; // deterministic + fast: ONNX worker (CoreML is covered above)
    const { getPaprAppsRoot } = await import("../../src/core/utils/paprRoot.js");
    appDir = path.join(getPaprAppsRoot(), APP_ID);
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "uploader.ts"), `// Upload with retries\n${RETRY}\n`);
    fs.writeFileSync(path.join(appDir, "src", "reports.sql"), `-- weekly signups\n${SQL}\n`);
    fs.writeFileSync(path.join(appDir, "src", "billing.ts"), `// Billing documents\n${INVOICE}\n`);
    const { getCodeEmbedRuntime } = await import("../../src/core/tools/codeEmbed/runtime.js");
    rt = await getCodeEmbedRuntime();
    expect(rt, "runtime disabled").toBeTruthy();
  }, 120_000);
  afterAll(async () => {
    const { resetCodeEmbedRuntime } = await import("../../src/core/tools/codeEmbed/runtime.js");
    await resetCodeEmbedRuntime();
  });

  const grep = async (pattern: string) => {
    const { executeBashCommand } = await import("../../src/core/tools/bash.js");
    const t = Date.now();
    const r: any = await executeBashCommand({ command: `grep -rn "${pattern}" ${appDir}`, timeout: 30_000 } as any);
    return { ms: Date.now() - t, out: String(r?.data?.stdout ?? r?.error ?? "") };
  };
  const deviceBlock = (out: string) => out.match(/=== Semantic code search \(papr-embed-code[^\n]*\n([\s\S]*?)(\n\n|\n===|$)/)?.[1] ?? "";

  test("cold grep is not slowed down and output is unchanged", async () => {
    const r = await grep("upload");
    expect(r.ms).toBeLessThan(3000);
    expect(r.out).toContain("uploader.ts");
  });

  test("after background indexing, a natural-language grep is answered by the model", async () => {
    rt.touch(appDir, true);
    for (let i = 0; i < 240 && !(rt.backend !== "none" && rt.store.stats().chunks >= 3 && rt.store.pendingBlobs().length === 0); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(rt.store.stats().chunks, `status=${rt.status} tier=${rt.tier} backend=${rt.backend} roots=${[...rt.roots]} stats=${JSON.stringify(rt.store.stats())} appDir=${appDir}`).toBeGreaterThanOrEqual(3);
    // No file contains this phrase: plain grep finds nothing, the model must.
    const r = await grep("generate a pdf for a customer order");
    const block = deviceBlock(r.out);
    expect(block, `rt status=${rt.status} backend=${rt.backend} stats=${JSON.stringify(rt.store.stats())}\n${r.out.slice(0, 800)}`).not.toBe("");
    expect(block.split("\n")[0]).toContain("src/billing.ts");
    expect(r.out).toContain("=== Grep Results");
  }, 180_000);

  test("a file the agent just wrote is found on the next grep", async () => {
    fs.writeFileSync(path.join(appDir, "src", "ledger.ts"), "// Reconcile Stripe payouts against the ledger and flag refunds that never settled\nexport function reconcileRefunds(){ return [] }\n");
    rt.touch(appDir, true);
    for (let i = 0; i < 120 && rt.store.pendingBlobs().length; i++) await new Promise((r) => setTimeout(r, 250));
    const r = await grep("unsettled refunds in payouts");
    expect(deviceBlock(r.out).split("\n")[0]).toContain("src/ledger.ts");
  }, 120_000);

  test("PAPR_CODE_EMBED=0 turns it off and grep still works", async () => {
    const { resetCodeEmbedRuntime } = await import("../../src/core/tools/codeEmbed/runtime.js");
    await resetCodeEmbedRuntime();
    process.env.PAPR_CODE_EMBED = "0";
    try {
      const r = await grep("reconcileRefunds");
      expect(deviceBlock(r.out)).toBe("");
      expect(r.out).toContain("ledger.ts");
    } finally {
      delete process.env.PAPR_CODE_EMBED;
    }
  });
});
