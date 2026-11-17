// Parity: the bench's Python vectors must equal what the desktop OnnxEmbedder produces for the same chunks.
//   tsx scripts/curation-bench/parity.mts <modelRoot> <dataDir> <vecDir> [n=5]
// Fails (exit 1) if any cosine < 0.999. Run on the Mac before trusting a GPU-built index.
import * as path from "path";
import * as fs from "fs";
import { loadEmbedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { gunzipLines, loadNpyF16 } from "./lib.mts";

const [modelRoot, dataDir, vecDir, nArg] = process.argv.slice(2) as [string, string, string, string?];
const n = Number(nArg ?? 5);
const emb = await loadEmbedder(modelRoot);
const V = loadNpyF16(path.join(vecDir, "chunks.npy"));
let i = 0, worst = 1;
for await (const l of gunzipLines(path.join(dataDir, "chunks.jsonl.gz"))) {
  if (i >= n) break;
  const c = JSON.parse(l);
  const [v] = await emb.embedDocuments([c.text]);
  let s = 0;
  for (let d = 0; d < V.dim; d++) s += v![d]! * V.data[i * V.dim + d]!;
  worst = Math.min(worst, s);
  console.log(`chunk ${i} ${c.blob.slice(0, 8)}#${c.chunk}: cos ${s.toFixed(5)}`);
  i++;
}
const Q = JSON.parse(fs.readFileSync(path.join(dataDir, "queries.json"), "utf8"));
const qids = JSON.parse(fs.readFileSync(path.join(vecDir, "queries.json"), "utf8")) as string[];
const QV = loadNpyF16(path.join(vecDir, "queries.npy"));
const qv = await emb.embedQuery(Q[qids[0]!].queries[0]);
let qs = 0;
for (let d = 0; d < QV.dim; d++) qs += qv[d]! * QV.data[d]!;
console.log(`query ${qids[0]}: cos ${qs.toFixed(5)}`);
worst = Math.min(worst, qs);
await emb.close();
console.log(worst >= 0.999 ? `PARITY OK (worst ${worst.toFixed(5)})` : `PARITY FAIL (worst ${worst.toFixed(5)})`);
process.exit(worst >= 0.999 ? 0 : 1);
