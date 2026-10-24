# ADR 0004 — How Papr Work hosts the engine (M7.0 spike)

- Status: Accepted
- Date: 2026-09-28
- Evidence: `Papr-ai/paprwork@faf6de5` (v2.6.18), read-only review

## Questions the spike had to answer (BUILD_PLAN.md §11.5)

1. How does a Papr job receive its database?
2. Can a `node` job run an npm binary?
3. How do Papr custom keys reach a job?
4. How is local-only placement declared?
5. How does a mini-app reach server-side code?

## Findings

1. **Databases.** `CommandJobExecutor` gives every job `JOB_DIR` and a per-job `JOB_DB`, plus `PAPR_DB_<KEY>` variables for registry databases in `writeDbIds` (`jobAppDatabase.ts`, `jobWriteDatabaseEnv`). Registry databases in replica mode (Turso-synced) are opened read-only; writes must go through the gateway proxy, and `replicaBashSqliteGuard.ts` / `replicaJobScriptGuard.ts` block raw SQLite writes to them. The proxy executes one statement per request, with no multi-statement transactions.
2. **npm binaries.** A `node` job whose `JOB_DIR` has a `package.json` gets `npm install --production` before its first run, so a job can depend on `@splitin/outreach-cli` and run it.
3. **Keys.** Keys are injected as child-process environment variables, only when listed in the job's `requiredKeys` or referenced as `${KEY}` in its command. Keys set to "ask" prompt the user.
4. **Placement.** `executionCapability` is `local-only | local-preferred | cloud-preferred`. App-linked jobs default to `local-preferred`, and the portable bundle `JobSpec` has no field for it, so placement is set after import.
5. **Mini-app to server.** Mini-apps call `POST /api/app/backend/:action`. Handlers live in `apps/{appId}/backend/` with a `manifest.json` declaring `handler`, `runtime` (python, node, typescript) and `keys`. The handler gets `PAPR_ACTION_PARAMS` (string values) and the declared keys as environment variables, and writes its answer to stdout.

## Decisions

- **The engine keeps its own SQLite file, not a Papr registry database.** The engine depends on `BEGIN IMMEDIATE` multi-statement transactions (claim, preflight, result, atomic stop). Papr's replica proxy is one statement per request, and raw writes are blocked by design. Default path: `~/Papr/outreach/outreach.db` (`OUTREACH_DB` overrides it).
- **The Papr app is a client of the HTTP API.** The mini-app's backend handler (`outreach.mjs`, Node, no dependencies) calls the engine's loopback API with `OUTREACH_API_URL` and `OUTREACH_API_TOKEN`, declared as keys with `clientAccess: server`. The token never reaches the browser. A read-only dashboard gets a `viewer`-ceiling token; approving needs an `approver` token.
- **Only allowlisted actions.** The handler maps a fixed set of action names to fixed routes; it never forwards arbitrary paths or methods.
- **Papr may host the worker for pilots.** `jobs/outreach-worker` is a `node` job whose `package.json` depends on `@splitin/outreach-cli` and runs `outreach worker --once` every minute. After import, set it to `local-only`: provider secrets and the database are on this machine.
- **Production does not depend on the desktop staying awake** (decision D2): run `outreach worker --loop` and `outreach serve` under launchd/systemd, and use the Papr app only as the operator UI.

## Consequences

- No Papr core change is needed, and nothing about the integration depends on upstream review.
- Two things must run for the Papr UI to work: the API (`outreach serve`) and a worker (the Papr job or a service). The app's empty state says so.
- Not yet verified on a live Papr install: bundle import, backend action invocation and the worker job's npm install. The bundle is validated against a copy of Papr's manifest schema and the backend handler is tested against a real API server, but the first run on a real install is still an acceptance step.
- `@splitin/outreach-cli` must be published (M10) before the worker job can install it from npm; until then, point its `package.json` at a local path.
