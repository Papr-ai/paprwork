# Sync V3 environment variables

Sync V3 is **always on** in this build — row sync, writer ops, and schema migration replay via workspace log (memory applies DDL to Turso on append).

**Desktop mini-app writes:** `/api/db/write` is **local-first** when cloud sync is enabled (`CLOUD_SYNC_ENABLED !== "false"`). Local SQLite updates immediately; `_papr_sync_log` CDC ships to workspace log on debounced push (~5s after interactive writes). When cloud sync is off, writes stay local-only.

**Packaged desktop builds:** gateway service secrets are baked via `scripts/generate-packaged-gateway-env.mjs` in release CI → `Resources/packaged-gateway-env.json`.

### GitHub secrets (release CI — optional overrides)

Defaults live in `src/resources/packaged-gateway-env.defaults.json` and are baked into every release. GitHub secrets override when set:

| Secret | Overrides default for |
| --- | --- |
| `PAPR_APP_REPO_WRITER_URL` | Cloud Run app-repo-writer URL |
| `PAPR_CLOUD_APP_HOST_KEY` | Shared secret for apps.papr.ai refresh + Turso notify |
| `PAPR_MEMORY_SERVER_URL` | Memory server base URL (`https://memory.papr.ai`) |

Packaged apps also load defaults at runtime if `packaged-gateway-env.json` is empty or missing keys (fixes installs that shipped `{}`).

**Not packaged (by design):** `PAPR_API_KEY` (user login / keychain), AI provider keys, Auth0 (`papr.auth0.com` defaults), `PAPR_PLATFORM_URL` (`dashboard.papr.ai` default), `VITE_REQUIRE_PAPR_AUTH` (Vite build time).

## Must-have (production)

### Desktop gateway

| Variable | Default (dev) | Required when |
| --- | --- | --- |
| `PAPR_API_KEY` | keychain | Always — Papr login provisions this |
| `PAPR_MEMORY_SERVER_URL` | `https://memory.papr.ai` | Non-default memory server |
| `PAPR_APP_REPO_WRITER_URL` | Cloud Run writer (built-in) | Only to override — e.g. `http://127.0.0.1:8789` for local writer dev |
| `PAPR_CLOUD_APP_HOST_KEY` | packaged JSON / `.env.local` | Notify `apps.papr.ai` after DB/code sync (not user API key) |

**Auth:** Desktop calls app-repo-writer with the user's `PAPR_API_KEY` only. Writer validates namespace ACL via memory server RepoRegistry — no shared writer secret on the open-source client (same idea as cloud-app-host using a server-side key to call memory, not the reverse).

Local dev: `npm run start:app-repo-writer` — defaults work without setting anything.

### Memory server

| Variable | Default | Required when |
| --- | --- | --- |
| `GITHUB_ORG` | none | **Always** — primary GitHub org + shard name prefix |
| `GITHUB_APP_ID` | none | **Always** — GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | none | **Always** — GitHub App key |
| `PAPR_APP_REPO_SHARD_MAX_REPOS` | **80,000** | Optional capacity tuning |

Shard orgs are **auto-derived**: `{GITHUB_ORG}`, `{GITHUB_ORG}-shard-2`, `{GITHUB_ORG}-shard-3`, … discovered from `app_repo_registry` and selected automatically when capacity is reached. No manual shard env list.

### App-repo-writer (Cloud Run)

| Variable | Default | Required when |
| --- | --- | --- |
| `PAPR_MEMORY_SERVER_URL` | none | **Always** — RepoRegistry ACL lookup |
| GitHub App creds | none | **Always** — push to per-app repos |

No `PAPR_APP_REPO_WRITER_KEY`. No `PAPR_PLATFORM_URL` (that is desktop login/billing only).

## Optional

| Variable | Where | Purpose |
| --- | --- | --- |
| `PAPR_APP_REPO_COMMITTED_WEBHOOK_URL` | writer | POST to cloud-app-host `/internal/app-repo-committed` (requires `PAPR_CLOUD_APP_HOST_KEY` on writer) |
| `PAPR_APP_REPO_COMMITTED_TOPIC` | writer deploy | GCP Pub/Sub topic — push subscription targets cloud-app-host |
| `PAPR_PLATFORM_URL` | **Electron/desktop only** | Papr dashboard for login/billing (default `https://dashboard.papr.ai`) |

Cloud app host, cloud agent gateway, and writer do **not** need `PAPR_PLATFORM_URL` — they talk to `PAPR_MEMORY_SERVER_URL`.

## Removed — do not set

- `SYNC_V3_PER_APP_REPOS`, `SYNC_V3_WRITER_OPS`, `SYNC_V3_LOG_ROWS`, `SYNC_V3_SCHEMA_LOG` (always on; reported on heartbeat)
- `SYNC_V3_CUTOVER_MODE`, `SYNC_V3_DISPATCH_PUSH`, `SYNC_V3_RELEASES`
- `PAPR_APP_REPO_WRITER_KEY` (desktop must never ship this)
- `PAPR_APP_REPO_SHARD_ORGS` (shards auto-derived from `GITHUB_ORG`)
- `SYNC_V3_MIGRATION_TOKEN` (namespace app-split uses normal cloud API auth)

## Local dogfood (3 terminals)

```bash
# 1. Memory server
cd ../memory && poetry run python main.py

# 2. App-repo-writer
npm run start:app-repo-writer

# 3. Paprwork
npm start
```

No sync flags needed.
