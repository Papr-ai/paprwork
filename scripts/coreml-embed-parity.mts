// Real-model check of the Neural Engine path: Node -> Swift helper -> CoreML, vs sentence-transformers fp32 reference
// vectors, plus the ONNX fallback for long files.
//   tsx scripts/coreml-embed-parity.mts <modelRoot> <ref.json> <helper>
import * as fs from "fs";
import { loadBestEmbedder } from "../src/core/tools/codeEmbed/embedder.js";

const [root, refPath, helper] = process.argv.slice(2) as [string, string, string];
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
const t0 = Date.now();
const e: any = await loadBestEmbedder(root, { helper });
const out: any = { backend: e.constructor.name, maxTokens: e.maxTokens ?? null, load_ms: Date.now() - t0, queries: [], docs: [] };
const cos = (a: Float32Array, b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
for (const [q, v] of ref.queries) {
  await e.embedQuery(q); // warm
  const ts: number[] = [];
  let x!: Float32Array;
  for (let i = 0; i < 5; i++) { const s = performance.now(); x = await e.embedQuery(q); ts.push(performance.now() - s); }
  ts.sort((a, b) => a - b);
  out.queries.push({ p50_ms: +ts[2]!.toFixed(1), cos: +cos(x, v).toFixed(5) });
}
for (const [d, v] of ref.docs) {
  const s = performance.now(); const [x] = await e.embedDocuments([d]);
  out.docs.push({ tokens: e.countTokens(d), ms: Math.round(performance.now() - s), cos: +cos(x!, v).toFixed(5) });
}
await e.close();
console.log(JSON.stringify(out));
