# Curation Bench

Regression gate for the code harness (hybrid grep: papr-embed-code-1-0.6b + code graph + "also check").

**What it replays:** 75 real `grep` calls from Paprwork sessions, labelled by hand: 50 where grep missed the file the agent
needed, 25 controls where grep found it. Each row has the repo snapshot at that moment (git blob shas), the agent's
command, and the gold file(s). This is the set behind "44 of 50 misses recovered" in the deck.

**What it runs:** the shipped code, not a re-implementation.

| Step | Code | Where |
|---|---|---|
| Chunk every file | `chunker.ts` `chunkFile` + the real tokenizer | `export-chunks.mts` (CPU) |
| Embed chunks + queries | ONNX int8 `model_quantized.onnx`, same recipe as `OnnxEmbedder` (parity-checked, cos ≥ 0.999) | `embed_chunks.py` (GPU, cached) |
| Local path | best chunk per file, top 10 (`CodeVectorStore.search`) | `rank.mts` |
| Cloud path | memory's `CodeContextStore` over Qdrant: upload vectors only, `code_search` filtered to the row's blob shas | memory `scripts/curation_bench_cloud.py` |
| Harness | `rankPointers` (v1.1 graph re-rank + 2 "also check") | `rank.mts` |
| Gate | ≥ 41 of 50 misses, and no group more than 1 row below `baseline.json` | `gate.mts` |

**Metrics** (per group): `top10` = semantic search alone; `harness` = top 10 + 2 also-check files (the deck metric);
`shown` = anything the grep output shows (8 semantic lines + 3 pointers + 2 also check).

**Run it locally** (vectors from GCS; ~2 min on a laptop):

```sh
B=gs://papr-hne-artifacts/curation_bench
gcloud storage cp -r "$B/dataset/v1/*" cb/data/ && gcloud storage cp -r "$B/vectors/<key>/out/v10_int8/*" cb/vecs/
npx tsx scripts/curation-bench/rank.mts cb/data cb/vecs cb/local.json
npx tsx scripts/curation-bench/gate.mts cb/local.json --baseline scripts/curation-bench/baseline.json --arm local
```

**When the model or chunker changes**, the vectors key changes and CI stops with a message. Run the workflow with
`rebuild=true` (spot L4, ~1 h), then re-run. Update `baseline.json` in the same PR only when the change is meant to
move the numbers, and say why in the PR.

**Data handling:** the dataset holds private source files, so it lives only in GCS (`curation_bench/dataset/v1`), never
in this public repo. CI reads it with a dedicated service account (`gha-curation-bench`, bucket prefix only) through
workload identity; per-row results go back to the bucket, and only the summary table is posted on the PR.
