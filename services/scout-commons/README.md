# Scout Commons: shared public data for Scout

Scout Commons answers questions about companies whose answer is **the same for every Scout user**. It works each one out once and serves it to everyone. It has four parts:

| Part | Question it answers | Source |
|---|---|---|
| **Lookalikes** | Which companies look like this one? | Common Crawl's domain web graph (133M domains, 2B links, about 9 GB, rebuilt quarterly) |
| **Email patterns** | How does this company format its email addresses (`first.last@`, `flast@` …)? | Addresses published on the company's own pages, and commit authors in its own GitHub org |
| **Job boards** | Which public job boards does this company use, and is it hiring? | Links on the company's own careers pages, vendor job APIs, and the Common Crawl URL index |
| **Dataset definitions** | How do you read sales signals from this city's or state's open data? | Definitions submitted by Scout installs, checked automatically before they're shared |

## What it holds, and what it never holds

**Holds:** public link data, computed lookalike lists, email *patterns* with sample counts and source URLs, job-board slugs with job counts and posting dates, and dataset definitions.

**Never holds:**
- **Email addresses.** They're read in memory to work out the pattern, then discarded. A test checks that no `@` reaches the store.
- **User data:** runs, leads, people, contacts or labels.
- **Who asked.** Requests carry only a domain or a definition, and every caller gets the same answer.

**Rules for outbound requests:**
- **Company pages:** the worker identifies itself with a User-Agent that links here, honours `robots.txt`, waits at least 1 s between requests to the same host, and reads at most 400 KB of a page.
- **Private addresses:** it refuses non-public IP addresses on every redirect.
- **No probing:** no SMTP checks, no catch-all probing, and no account-lookup endpoints such as Gravatar.
- **Opting out:** a company can opt out of email patterns with `python -m commons.compute --optout example.com`. The pattern is deleted and never computed again.

## API

| Endpoint | Returns |
|---|---|
| `GET /commons/v1/health` | `{ok, release}`. No key needed. |
| `GET /commons/v1/release` | The live graph release, its build stats, and the job-board index crawl. |
| `GET /commons/v1/neighbors?domain=lemlist.com&k=50` | Lookalikes, highest score first. `k` is at most 500. |
| `GET /commons/v1/pattern?domain=sentry.io` | `{pattern, samples, conflicting, confidence, sources, provider, mx_ok}` |
| `GET /commons/v1/ats?domain=lemlist.com` | `{boards: [{vendor, slug, url, jobs_open, newest_posted, found_via}]}` |
| `GET /commons/v1/ats/boards?vendor=greenhouse&offset=0&limit=1000` | Every board slug Common Crawl saw for one vendor. |
| `GET /commons/v1/recipes?state=IL&city=Chicago&signal_type=` | Shared (validated) dataset definitions. |
| `GET /commons/v1/recipes/{id}` | One definition with its status and check results. |
| `POST /commons/v1/recipes` | Submit a definition. It returns `pending`, and the worker checks it. |

### Per-domain lookups (`neighbors`, `pattern`, `ats`)
- **First request:** returns `202 queued`, and the worker fills it in within a few minutes.
- **Results go stale:** patterns after 90 days, job boards after 7 days. A stale result is still returned, with `stale: true`, and is re-queued.

### Email patterns
- **How it works:** the pattern is the one that explains the most distinct addresses. Each address is matched to a person named on the same page, or to the author of the commit it came from. Role addresses (`info@`, `sales@` …) are ignored.
- **Confidence:** `confirmed` means 2 or more addresses support the pattern; `single` means only 1. `conflicting` counts addresses that follow a different pattern.
- **GitHub:** set `COMMONS_GITHUB_TOKEN` to read commits from the GitHub org that the company's homepage links to. Without it, only website pages are used, and many companies don't publish personal addresses there.

### Job boards
- **Vendors covered:** Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio, Teamtailor and BambooHR.
- **`found_via: site`:** the company's own careers pages link to the board.
- **`found_via: guess`:** the domain name was tried as a board slug on Greenhouse, Lever and Ashby. It's only kept if that board has open jobs. Treat it as weaker evidence, because another company could own that slug.
- **The board index** is rebuilt monthly (`--ats-index`). It reads the newest crawl's `cluster.idx` and range-fetches only each vendor's slice of the URL index.

### Dataset definitions
A submitted definition is shared only after automatic checks:
- **Structure:**
  - The dataset and every named column exist.
  - The date column is a real date type.
  - Its name doesn't look like an expiry, renewal or due date.
  - Filters use literal values only.
- **Freshness:**
  - At least 5 matching rows in the last 90 days.
  - The newest row is no more than 14 days old.

Structural failures are `rejected`, and freshness failures are `stale`. Shared definitions are rechecked weekly. Six seed definitions ship in `seed_recipes.json` (`--seed-recipes`). v1 supports Socrata portals.

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
| **Worker** `python -m commons.compute` | Cloud Run job | every 5 minutes | 4 vCPU, 8 GB. Works through the lookalike, pattern, job-board and definition queues. |
| **Board index** `python -m commons.compute --ats-index` | Cloud Run job | monthly | 1 vCPU, 1 GB, under a minute (about 15,000 boards). |
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
| `COMMONS_GITHUB_TOKEN` | unset | Read-only GitHub token for commit-author email patterns |
| `COMMONS_HOST_GAP_S` | `1.0` | Minimum seconds between requests to one host |

## Not in this PR

- **Deployment.** The GCP project, bucket, service account, Cloud Run service and job, and the quarterly Cloud Batch schedule still need to be created. `cloudbuild.yaml` only builds the image.
- **The Scout client.** Scout's `commons.py` (spec `lib/scout/commons.py`) calls Commons when `PAPR_COMMONS` is set and otherwise uses its own sources. It will ship in the Scout app.
- **Domain cache and Overture extracts** from the original Commons proposal.
- **ArcGIS and CKAN** dataset definitions (Socrata only for now).
- **Automatic dataset discovery.** Scout installs submit definitions; Commons only checks and shares them.
- **Sister-brand filtering** (same registrant, or a redirect to the seed). That needs page fetches, so Scout does it client-side.
