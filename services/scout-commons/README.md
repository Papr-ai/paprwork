# Scout Commons: shared link-graph lookalikes

Scout's best way of finding companies similar to a seed company is the link graph: sites that the same blogs, directories and review pages link to are probably alike. The data behind it is Common Crawl's domain-level web graph (about 133 million domains and 2 billion links). That's roughly 9 GB once processed, it's rebuilt every quarter, and **the answer is the same for every user**.

Without this service each Scout install would have to download and rebuild that graph itself, and cloud runs couldn't use it at all. Scout Commons builds it once and answers `neighbors?domain=` for everyone.

This first version serves **lookalikes only**. Other shared data proposed for Commons (email patterns, job-board index, open-data recipes) is deliberately left out until the privacy and review questions are settled.

## What it holds

- Common Crawl's public domain graph, processed into parquet (`vertices`, `deg`, `rev`, `fwd`).
- Computed lookalike lists, one JSON file per seed domain requested.
- A queue of seed domains waiting to be computed.

**It never holds user data.** No runs, leads, people, contacts or labels. Requests carry only a domain, and every caller gets the same answer.

## API

| Endpoint | Returns |
|---|---|
| `GET /commons/v1/health` | `{ok, release}`. No key needed. |
| `GET /commons/v1/release` | The live graph release and its build stats. |
| `GET /commons/v1/neighbors?domain=lemlist.com&k=50` | Lookalikes, highest score first. `k` is at most 500. |

`/neighbors` responses:

- **`200 {"status":"ready", "neighbors":[{domain, score, shared_citers}], "citers", "matched_domain", "release"}`**: computed. `score` is 0 to 1, relative to the best match for that seed.
- **`202 {"status":"queued", "retry_after":120}`**: the first time anyone asks for a seed. The worker computes it, usually within a few minutes. Scout should fall back to its other sources for this run and use Commons next time.
- **`200 {"status":"not_in_graph", "neighbors":[]}`**: Common Crawl has no links to this domain, which is common for very small or new companies.
- `400` not a domain · `401` missing or wrong `X-API-Key` (when keys are configured) · `503` no release built yet.

Input is normalised (`https://www.Lemlist.com/pricing` → `lemlist.com`). A subdomain falls back to its parent domain if only the parent is in the graph.

## Scoring

For a seed *s* and candidate *t*, over each site *c* that links to both:

```
w(s,t)  = Σ 1 / ln(1 + outdeg(c))      a link from a focused blog counts more than one from a big list
score   = w(s,t) / sqrt(indeg(t))       damps sites everyone links to (google.com, popular tools)
```

- Sites with more than 2,000 outlinks (directories, link farms) are dropped at build time.
- A candidate needs at least 3 shared linking sites.
- The seed's own subdomains are removed.

This is score **D** from the Scout research (spec §2.9). On the 2026 graph it put 10 of 18 known lemlist lookalikes in the top 20, the best of the methods tested.

## How it runs

One image (`Dockerfile`), three entry points, sharing a GCS bucket mounted at `COMMONS_DATA_DIR`:

| Part | Runs as | Schedule | Needs |
|---|---|---|---|
| **API** `uvicorn commons.api:app` | Cloud Run service | always on | 1 vCPU, 512 MB. Serves file reads. |
| **Worker** `python -m commons.compute` | Cloud Run job | every 5 minutes | 4 vCPU, 8 GB. Computes queued seeds against the parquet graph. |
| **Builder** `python -m commons.build` | Cloud Batch or a VM | quarterly, after Common Crawl publishes a graph | 16 GB RAM, 60 GB scratch disk, about an hour. |

The builder downloads the newest graph listed in `graphinfo.json` (resuming partial downloads), converts it, then switches `current` to the new release. It also re-queues every seed that was computed for the old release, so the new one warms up from real demand.

Storage is about 9 GB per release plus a few KB per computed seed. Keeping two releases means about 20 GB.

## Local development

```bash
cd services/scout-commons
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q                      # tiny fixture graph, < 1 s
.venv/bin/ruff check commons tests

# Run the API against a local store; COMMONS_INLINE=1 computes misses in the request
COMMONS_DATA_DIR=./data COMMONS_INLINE=1 .venv/bin/uvicorn commons.api:app --port 8790
curl 'localhost:8790/commons/v1/neighbors?domain=lemlist.com&k=20'
```

A full local build (`python -m commons.build --data-dir ./data --work-dir ./work`) needs the same 16 GB RAM and 60 GB disk as production.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `COMMONS_DATA_DIR` | `./data` (`/mnt/commons` in the image) | Store root |
| `COMMONS_API_KEYS` | unset (open) | Comma-separated keys accepted in `X-API-Key` |
| `COMMONS_INLINE` | unset | `1` computes misses inside the request (dev only) |
| `COMMONS_THREADS` | `4` | DuckDB threads for queries |
| `COMMONS_BUILD_MEM` | `14GB` | DuckDB memory limit for the builder |
| `COMMONS_WORK_DIR` | `./work` | Builder scratch space |

## Not in this PR

- **Deployment.** The GCP project, bucket, service account, Cloud Run service and job, and the quarterly Cloud Batch schedule still need to be created. `cloudbuild.yaml` only builds the image.
- **The Scout client.** Scout's `commons.py` (spec `lib/scout/commons.py`) calls `/neighbors` when `PAPR_COMMONS` is set and otherwise uses its own sources. It will ship in the Scout app.
- **The other Commons data**: email patterns, job boards, domain cache, open-data recipes and Overture extracts.
- **Sister-brand filtering** (same registrant, or a redirect to the seed). That needs page fetches, so Scout does it client-side.
