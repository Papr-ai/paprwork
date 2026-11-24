// Real-model check: paprwork's ONNX embedder vs PyTorch fp32 reference vectors (written by the Python side).
import * as fs from "fs";
import { loadEmbedder } from "../src/core/tools/codeEmbed/embedder.js";
const root = process.argv[2]!; const ref = JSON.parse(fs.readFileSync(process.argv[3]!, "utf8"));
const t0 = Date.now(); const e = await loadEmbedder(root); const load = Date.now() - t0;
const cos = (a: Float32Array, b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const out: any = { load_ms: load, queries: [], docs: [] };
for (const [q, v] of ref.queries) { const s = Date.now(); const x = await e.embedQuery(q); out.queries.push({ ms: Date.now() - s, cos: +cos(x, v).toFixed(5) }); }
for (const [d, v] of ref.docs) { const s = Date.now(); const [x] = await e.embedDocuments([d]); out.docs.push({ ms: Date.now() - s, tokens: e.countTokens(d), cos: +cos(x!, v).toFixed(5) }); }
console.log(JSON.stringify(out));
