// Curation Bench, step 3 of 3: rank every replay row with the shipped harness and score it.
//   tsx scripts/curation-bench/rank.mts <dataDir> <vecDir> <out.json> [--dense cloud_dense.json] [--query writer|pattern]
//
// Per row (50 grep misses + 25 controls from real Paprwork sessions):
//   dense   local: best chunk per file over the row's snapshot (CodeVectorStore.search semantics, top 10 files)
//           cloud: the hits memory's code_search returned for the row (scripts/curation_bench_cloud.py in memory)
//   fusion  rankPointers() from codeSearchV2.ts: v1.1 graph re-rank (3 pointers) + 2 "also check" files
// Scores, per group:
//   top10   gold in the dense top 10 (what the semantic block alone finds)
//   harness gold in dense top 10 + the 2 also-check files (the metric behind 44/50 in the deck)
//   shown   gold anywhere in what the grep output actually shows: 8 semantic lines + 3 pointers + 2 also check
import * as fs from "fs";
import * as path from "path";
import { Repo } from "../../src/core/tools/codeCandidates.js";
import { rankPointers } from "../../src/core/tools/codeSearchV2.js";
import type { SourceFile } from "../../src/core/tools/codeFusion.js";
import { gunzipLines, loadNpyF16, readCorpusFilter, detectGrep } from "./lib.mts";

const [dataDir, vecDir, outPath] = process.argv.slice(2) as [string, string, string];
const flag = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const denseFile = flag("--dense");
const queryMode = (flag("--query") ?? "writer") as "writer" | "pattern";

const S = JSON.parse(fs.readFileSync(path.join(dataDir, "set.json"), "utf8")) as Record<"miss" | "ctrl", any[]>;
const snaps = JSON.parse(fs.readFileSync(path.join(dataDir, "snapshots.json"), "utf8")) as Record<string, { files: [string, string][] }>;
const Q = JSON.parse(fs.readFileSync(path.join(dataDir, "queries.json"), "utf8")) as Record<string, { queries: string[]; symbols: string[] }>;
const text = new Map<string, string>();
for await (const l of gunzipLines(path.join(dataDir, "blobs.jsonl.gz"))) { const b = JSON.parse(l); text.set(b.blob, b.text); }

// Local dense: chunk vectors + query vectors from embed_chunks.py
let dense: (iid: string, files: [string, string][]) => Array<{ path: string; score: number }>;
if (denseFile) {
  const D = JSON.parse(fs.readFileSync(denseFile, "utf8")) as Record<string, Array<{ path: string; score: number }>>;
  dense = (iid) => D[iid] ?? [];
} else {
  const keys = JSON.parse(fs.readFileSync(path.join(vecDir, "chunks.json"), "utf8")) as Array<[string, number, number, number]>;
  const V = loadNpyF16(path.join(vecDir, "chunks.npy"));
  const qids = JSON.parse(fs.readFileSync(path.join(vecDir, queryMode === "writer" ? "queries.json" : "queries_pattern.json"), "utf8")) as string[];
  const QV = loadNpyF16(path.join(vecDir, queryMode === "writer" ? "queries.npy" : "queries_pattern.npy"));
  const rowsOf = new Map<string, number[]>();
  keys.forEach(([b], i) => rowsOf.set(b, [...(rowsOf.get(b) ?? []), i]));
  dense = (iid, files) => {
    const qi = qids.indexOf(iid);
    const q = QV.data.subarray(qi * QV.dim, (qi + 1) * QV.dim);
    const best = new Map<string, number>();
    for (const [, b] of files) {
      if (best.has(b)) continue;
      let m = -Infinity;
      for (const r of rowsOf.get(b) ?? []) {
        let s = 0; const o = r * V.dim;
        for (let d = 0; d < V.dim; d++) s += V.data[o + d]! * q[d]!;
        if (s > m) m = s;
      }
      if (m > -Infinity) best.set(b, m);
    }
    // CodeVectorStore.search: best chunk per blob, then every path holding that blob, top 10 paths.
    return files.filter(([, b]) => best.has(b)).map(([p, b]) => ({ path: p, score: best.get(b)! }))
      .sort((a, b) => b.score - a.score).slice(0, 10);
  };
}

const out: any[] = [];
const t0 = Date.now();
for (const g of ["miss", "ctrl"] as const) {
  for (const r of S[g]) {
    const files = snaps[r.iid]!.files;
    const corpus: SourceFile[] = files.filter(([p, b]) => readCorpusFilter(p, text.get(b) ?? "")).map(([p, b]) => ({ path: p, text: text.get(b) ?? "" }));
    const d = dense(r.iid, files);
    const q = Q[r.iid]!;
    const pattern = detectGrep(r.cmd) ?? "";
    // codePointerBlock shows nothing when the semantic search returned nothing: same here.
    const { pointers, alsoCheck } = d.length === 0 ? { pointers: [], alsoCheck: [] } : rankPointers(corpus, new Repo(corpus), {
      memoryHits: d, command: r.cmd, pattern,
      query: queryMode === "writer" ? [...q.queries, ...q.symbols].join(" ") : pattern,
    });
    const gold = new Set<string>(r.gold_in_corpus);
    const has = (ps: string[]) => ps.some((p) => gold.has(p));
    const top10 = d.slice(0, 10).map((h) => h.path);
    const also = alsoCheck.map((h) => h.path);
    const shown = [...d.slice(0, 8).map((h) => h.path), ...pointers.map((h) => h.path), ...also];
    out.push({ group: g, iid: r.iid, gold: [...gold], top10: has(top10), harness: has([...top10, ...also]), shown: has(shown),
      dense_rank: top10.findIndex((p) => gold.has(p)) + 1 || null, pointers: pointers.map((h) => h.path), also });
  }
}
const sum = (g: string, k: string) => out.filter((o) => o.group === g && o[k]).length;
const summary = Object.fromEntries((["miss", "ctrl"] as const).map((g) => [g, {
  n: out.filter((o) => o.group === g).length, top10: sum(g, "top10"), harness: sum(g, "harness"), shown: sum(g, "shown"),
}]));
fs.writeFileSync(outPath, JSON.stringify({ summary, dense: denseFile ? "cloud" : "local", query: queryMode, seconds: Math.round((Date.now() - t0) / 1000), rows: out }, null, 1));
console.log(JSON.stringify(summary));
