# Context Bench

Regression gate for how an agent recovers **earlier context**: something said 300 messages ago in a long chat, a fact
from another chat, a line in a document, or a question whose answer sits in the graph or an app database. Curation
Bench covers code files; this covers everything else the agent has to remember.

**Dataset (v1, 106 questions, hand-written with gold answers).** Built the Curation Bench way: every question was
written by hand against the real corpus, and every gold string was checked to appear in it (or in the SQL/GraphQL
result for structured questions).

| Group | n | What it tests |
|---|---|---|
| `chat_short` | 40 | One-line lookup of a fact said earlier in a 600-message chat ("Which IPs did I add to the dev MongoDB project?") |
| `chat_long` | 15 | 2–3 sentence, specific questions, the way people actually ask |
| `chat_full` | 12 | "Bring back that whole message": hit only if the exact earlier message comes back complete |
| `other_chat_*` | 15 | Facts from 6 other chats, with 20 unrelated chats as distractors |
| `document` | 12 | Facts inside Papr documents (30 docs in the haystack) |
| `graph` / `structured` | 12 | Investor/customer questions answered by the graph (GraphQL) or the data room DB (SQL), some multi-hop |

Haystack: 27 chats + 30 documents, cut into 5,689 units (2,000-char windows of one message or doc section), frozen at
a cutoff timestamp so later turns can't leak in.

**Methods.** `grep` (the keyword an agent would pick, results in file order), BM25, dense retrieval with
papr-embed (on-device 0.6B on the Neural Engine; cloud schema-4B with `memory:personal`), hybrids by reciprocal-rank
fusion, + Jev rerank of the top 20, production Papr memory search, and SQL/GraphQL. Each method runs at K = 3/5/10
and three context shapes: the chunk, the whole message, or the message with its neighbours.

**Metric.** Hit@K, p95 retrieval latency, tokens the agent would read, and Papr's Retrieval Loss:

```
Retrieval-Loss = −log10(Hit@K) + 0.5 · p95_ms / 100 + 0.01 · tokens / 1,000
```

**Gate.** `baseline.json` lists the shipped arms. CI fails if one drops more than 2 hits at its K or its loss rises
by more than 0.05, comments the table on the PR and opens an issue. Runs on PRs that touch the grep hook, the
on-device embedder, Jev or memory search; on every push to `main` (release); and weekly, because the memory server
and Jev change without a paprwork PR.

**Run it locally.**

```sh
B=gs://papr-hne-artifacts/context_bench/dataset/v1
gcloud storage cp -r "$B/*" ctx/data/
CTX_BENCH_DATA=ctx/data python scripts/context-bench/run.py lex dense
PAPR_API_KEY=... CTX_BENCH_DATA=ctx/data python scripts/context-bench/run.py jev memory structured
python scripts/context-bench/gate.py ctx/data/results_*.json --baseline scripts/context-bench/baseline.json
```

**Rebuilding the dataset** (only when you add questions or the corpus changes): `build_corpus.py` freezes the
haystack from a local workspace, `embed_local.py` embeds it on the Neural Engine with the shipped CoreML helper,
`embed.py <model> [band_schema]` embeds it with a cloud model. Upload `data/` to a new `dataset/vN` and bump
`DATA_VERSION` in the workflow.

**Data handling.** Questions, corpus and vectors contain private chat text, docs and investor rows. They live only in
GCS; this public repo has the code and the summary baseline.
