# Outreach Console for Papr Work

An optional, local-desktop console for the independently running outreach engine: upcoming actions, approvals, review, manual social touches, campaign health and a workspace kill switch.

**Status: compatibility preflight, not a validated Papr release.** The current contract baseline is Papr development commit [b34b6c4](https://github.com/Papr-ai/paprwork/commit/b34b6c4090adfb64109004d1a25645a3d3a2bd66), alongside release 2.7.2. Clean desktop import, the full `validate_app` workflow and worker execution inside Papr remain pending. The manifest's declared 2.6.0 floor is not a tested minimum. See [acceptance checklist](docs/ACCEPTANCE.md) and [provenance](compatibility.json).

## Boundaries

- The engine retains its own SQLite database and transactional/audit boundary. The console accesses only its HTTP API, not Papr registry databases. [ADR 0004](../../docs/adr/0004-papr-host-integration.md) records the original decision; this does not imply current Papr lacks atomic database operations.
- Browser modules call `/api/app/backend/:action`. The allowlisted backend handler injects the API token server-side and forwards fixed API routes. Backend/engine roles remain authoritative.
- The bundle depends on a separate local engine. It is not cloud-ready: a remote backend's `127.0.0.1` is not the user's desktop. Keep cloud publishing and sharing disabled during local acceptance. `sync.cloudReady: false` is descriptive metadata, not an enforcement guarantee.
- Optional job code runs a configured local CLI once. It never installs or downloads dependencies. Its schedule is disabled by default.
- The in-app confirmation dialog is ordinary UI, not trusted MCP/agent-host approval. Human decisions must still follow the engine's authorization requirements.

## Local prerequisites

Use Node 24 for the Papr compatibility baseline. In the engine workspace, install its normal workspace dependencies and build it using the engine's [instructions](../../README.md). The built entry is `packages/outreach-cli/dist/bin.js`; its workspace dependencies must remain available. Do not assume an npm registry release exists.

Initialize a separate test database and start `outreach serve` on loopback. Configure a test principal/token with the intended role. Begin with fake providers, an empty audience and live sending closed. Never put tokens or real contacts into the exported bundle, screenshots or test evidence.

## Import and connect

1. Import the local `bundle/` folder into Papr Work. Record the exact Papr version and OS. Keep the app private and cloud publishing disabled.
2. In Papr's integration-key settings, configure `OUTREACH_API_URL` (for example `http://127.0.0.1:8787`) and `OUTREACH_API_TOKEN`. These are user-scoped, server-only requirements. Use a viewer-role token when validating read-only behavior.
3. Confirm the imported app ID. The frontend accepts `?appId=<assigned-id>`, then `document.documentElement.dataset.appId`, then `outreach-console` as its fallback.
4. Verify overview data and role failures before enabling any mutation-capable account. Run `validate_app` and work through [ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Optional worker

The preferred independent engine worker can run outside Papr. To test the optional Papr job instead, configure its environment with:

- `OUTREACH_CLI_ENTRY`: absolute path to a trusted, regular, non-symlink built `packages/outreach-cli/dist/bin.js` file. Relative paths and HTTP/file URLs are rejected.
- `OUTREACH_DB`: absolute path to the initialized test engine database.
- `OUTREACH_HOME`: absolute engine home, if different from `$PAPR_HOME/outreach` (or `~/Papr/outreach`). An existing `outreach.config.mjs` there is passed to the trusted CLI.
- `OUTREACH_WORKER_TIMEOUT_MS`: optional deadline, 100–300000 milliseconds; default 120000. Cancellation or timeout terminates the child. Child stdout/stderr is suppressed to avoid leaking provider data; job output contains only status and redacted diagnostics.

Set the job to local-only and verify its actual execution location before running it. First run one pass with fake providers. Only enable scheduling after live acceptance and explicit operator setup; do not run both this schedule and another worker unintentionally. The wrapper has no package.json or package-install step. It does not remove the engine's separate build/dependency requirement.

## Included files

- `bundle/apps/outreach-console/`: browser entry, small `ui/` modules, styles and backend actions.
- `bundle/jobs/outreach-worker/code/run.mjs`: dependency-free optional local entry wrapper.
- `bundle/skills/outreach.md`: recommended agent operating guidance. Bundle import has not been verified to register this as an active skill; do not rely on its mere presence as enforcement.
- `src/`: engine-API contract, browser test-double, wrapper and compatibility tests.

Run `npx vitest run apps/papr/src` from the engine workspace after installing its normal dependencies. These are local tests, not a Papr desktop test.

## Contribution route

Keep the engine in its own repository. Seek maintainer agreement before proposing a small Papr integration/example or reusable host fix. The [community-apps guide](https://github.com/Papr-ai/paprwork-community-apps/blob/12fae6e6a4d5a367236c78bd701b876a404958e3/CONTRIBUTING.md) prohibits new listing PRs; rare curated offline templates require approval and normally no external dependencies. Do not publish this local-only bundle as a cloud app to bypass that requirement.
