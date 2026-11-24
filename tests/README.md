# Paprwork V2 — Test Organization

Inspired by the memory project's `test_v1_endpoints_sequential.py` pattern: **tiered suites**, **sequential execution**, and **JSON reports**.

## Quick start

```bash
nvm use 24
npm install

# CI-safe (no running services)
npm run test:sequential

# Same as npm test + jobs E2E
npm run test:sequential -- --tier=ci

# With gateway + memory stack
npm run test:stack -- up --with-memory
npm run test:sequential -- --tier=cloud

# Full stack (cloud app host + agent gateway)
npm run test:stack -- up --with-memory --with-cloud-host --with-agent-gateway
npm run test:sequential -- --tier=full --continue-on-fail

# Full stack (auto-start stack for the tier, tear down after)
npm run test:sequential -- --tier=cloud --start-stack --stop-stack
```

Reports: `test_reports/paprwork_report_<timestamp>.json`

## Layout

```
tests/                          # Vitest unit tests, one folder per product area
  <area>/*.test.ts              # see "Areas" below; `npm run test:area <area>`
  *.build.test.ts               # need dist/ — `npm run test:build` (runs after build in CI)
  *.live.test.ts                # real keys/network — `npm run test:live` (never CI)
  setup/ helpers/ fixtures/     # shared, not tests
  manual/                       # Ad-hoc debug scripts (NOT in CI)
test/
  integration/                  # Vitest integration (4 files)
  e2e/                          # Vitest e2e (2 files)
ui/__tests__/                   # Vitest UI tests
scripts/
  test-*.mjs                    # Script E2E runners
  test-stack.mjs                # Service orchestrator
  run-all-tests-sequential.mjs  # Sequential runner
  lib/
    testSuiteManifest.mjs       # Tier + step definitions
    testStackLib.mjs            # Stack up/down/health
    testEnv.mjs                 # Auth resolution
vitest.workspace.ts             # unit-backend | unit-ui | integration | e2e
```

## Areas

Put a new test in the folder of the area whose behavior it checks. Run one area
with `npm run test:area <area>`; list them with `npm run test:area`.

| Folder | What lives here |
|--------|-----------------|
| `cloud-sync/collaboration` | Owner vs contributor: proposals, change requests, get-updates, contribute flow |
| `cloud-sync/sharing` | Who can see what: share links, people allowlists, roles, ACLs, audiences |
| `cloud-sync/publish` | Publishing an app: git/app repo, writer ops, revisions, upload mode, flush |
| `cloud-sync/database` | Database sync: Turso replicas, push/pull, CDC, row replay, schema drift |
| `cloud-sync/jobs` | Job state across devices/cloud: run patches, tombstones, deletion catalog, scheduler authority |
| `cloud-sync/engine` | The sync machinery itself: coordinator, outbox, workspace log, vault sync, watchers |
| `cloud-runtime` | Cloud app host, sandbox, cloud agent runs, cloud install |
| `catalog` | Community catalog, install from catalog, featured apps |
| `apps` | Mini-apps locally: build, validate, backends, preview, lifecycle |
| `databases` | Local databases: registry, migrations, data sources, table access |
| `files` | App file storage and uploads |
| `jobs` | Local jobs: scheduler, runner, recipes, schedules |
| `agent` | Agent runtime: tools, turns, streaming, delegation, context, compaction |
| `chat` | Chat storage, messages, titles, rendering helpers |
| `memory` | Papr memory, wiki, code index, search, goals, briefs, documents |
| `providers` | Model providers, OAuth, usage/plan limits, model controls |
| `platforms` | Browser automation and connected platforms (LinkedIn, etc.) |
| `account` | Login, identity, billing/quota, API keys, vault keys |
| `workspace` | Workspace switch, tabs, settings, home, desktop shell state |
| `gateway` | Gateway infra: performance, diagnostics, packaging, process limits |

Shared `cloud-sync` vs `databases`: if the test only touches the local SQLite
file, it's `databases`; if it moves rows to/from the cloud, it's
`cloud-sync/database`. Same rule for `jobs` vs `cloud-sync/jobs`.

## Tiers

| Tier | Command | Services needed | What's included |
|------|---------|-----------------|-----------------|
| **ci** | `--tier=ci` | None | Vitest, build gateway, jobs E2E, independent DB E2E |
| **local** | `--tier=local` | Optional gateway | ci + package sanity + turso delta + turso sync session/overlap E2E (optional, needs auth) |
| **cloud** | `--tier=cloud` | Gateway + memory + auth | local + cloud-e2e + cloud-sync + papr-sdk |
| **full** | `--tier=full` | Full stack + API keys | cloud + app host + agent job E2E |

### Auth resolution (`scripts/lib/testEnv.mjs`)

1. `PAPR_API_KEY` in `.env.local`
2. Papr Work keychain (Electron subprocess)
3. Gateway proxy at `localhost:18789` when Papr Work is running + logged in

For cloud tiers without Electron: set `PAPR_API_KEY` in `.env.local`.

## Service stack

```bash
# Status of all services + which tiers are runnable
npm run test:stack -- status

# Start gateway only (standalone, no Electron)
npm run test:stack -- up

# Gateway + local memory (poetry/python — no Docker, same as memory project)
npm run test:stack -- up --with-memory-local

# Gateway + memory docker
npm run test:stack -- up --with-memory-docker

# Add cloud app host (:8787) and agent gateway (:8788)
npm run test:stack -- up --with-memory --with-cloud-host --with-agent-gateway

# Tear down managed processes + memory docker
npm run test:stack -- down
```

| Service | Port | Start |
|---------|------|-------|
| Paprwork Gateway | 18789 | `test-stack up` or `npm start` (Electron) |
| Memory server | 5001 / prod URL | prod: set `PAPR_MEMORY_SERVER_URL` in `.env.local` (default `https://memory.papr.ai`); local: `--with-memory-local` or `--with-memory-docker` |
| Cloud App Host | 8787 | `test-stack up --with-cloud-host` |
| Cloud Agent Gateway | 8788 | `test-stack up --with-agent-gateway` |

Logs: `.test-stack/logs/*.log`

## Vitest projects

```bash
npm test                    # unit-backend + unit-ui + integration
npm run test:unit           # backend only
npm run test:ui             # React only
npm run test:integration    # test/integration/
npm run test:e2e            # test/e2e/ (requires build)
npm run test:area <area>    # one product area, e.g. cloud-sync/collaboration
npm run test:build          # *.build.test.ts (requires build:gateway)
npm run test:live           # *.live.test.ts (real keys/network)
```

## Individual E2E scripts

See `package.json` `test:*` scripts. Common ones:

```bash
npm run test:jobs-e2e
npm run test:jobs-advanced
npm run test:cloud-e2e          # needs gateway + memory + auth
npm run test:cloud-sync
npm run test:cloud-app-host
npm run test:turso-sync-session-e2e   # integration — desktop reconcile + real Turso; bypasses heartbeat queue
npm run test:turso-sync-overlap-e2e   # integration — overlap/registry; calls syncTursoFromCloudDbChanged directly
npm run test:turso-bidirectional-e2e  # integration — Phase 2 merge across push/upload/watcher/heartbeat paths
npm run test:cloud-turso-db-changed-e2e   # full path — memory turso-db-changed → sync-index → desktop hydrate
```

### Turso sync test tiers

| Script | Tier | What it proves | Memory server heartbeat? |
|--------|------|----------------|------------------------|
| `test:sync-phase4-5-e2e` | integration | Phase 4+5: ordered flush, web-ready, SyncCoordinator, upload status | Tier A: Turso + `PAPR_API_KEY`. Tier B: gateway + `--app-id` |
| `test:flush-web-ready-e2e` | integration | Alias for `test:sync-phase4-5-e2e` | Same |
| `test:turso-sync-session-e2e` | integration | Scoped pull/push/skip on desktop | No — direct `syncTursoFromCloudDbChanged` |
| `test:turso-sync-overlap-e2e` | integration | No double push, registry scope | No — direct invoke |
| `test:turso-bidirectional-e2e` | integration | Web + desktop rows survive merge (B1–B8) | No — sync-index bumped locally |
| `test:cloud-turso-db-changed-e2e` | integration | Cloud write → memory bump → sync-index poll → local row | Yes — `turso-db-changed` + `syncTursoFromSyncIndex` |
| `test:cloud-runtime-phase` | cloud smoke | Heartbeat shape (`pendingCloudRuns`; Turso via sync-index) | Yes — after memory deploy |

## CI

GitHub Actions runs `--tier=ci` on PRs (`.github/workflows/test.yml`).

Cloud/full tiers are manual or scheduled — they need secrets and local/docker services.

## Adding a step to the sequential runner

Edit `scripts/lib/testSuiteManifest.mjs`:

1. Add a `TEST_STEPS` entry with `id`, `name`, `tiers`, `npmScript`, `requires`
2. Set `optional: true` if it should skip when requirements are missing
3. Run `npm run test:sequential -- --tier=<tier>`

Keep this README in sync with the manifest.
