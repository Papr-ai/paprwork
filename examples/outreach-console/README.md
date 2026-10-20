# Local Outreach Console example

**Draft example for maintainer review.** Placement under `examples/outreach-console` is provisional, not an established Papr extension point. This is an optional local adapter, not a built-in engine, a new generic SDK, a community-registry listing or a cloud-ready app.

The browser console shows upcoming actions, approvals, review items, manual tasks and campaign status. Seven fixed backend actions call a separately running [outreach engine](https://github.com/splitintech/open-internal-tools/tree/papr-adapter/outreach-engine). Its database, provider integrations and authorization remain outside Papr. No engine implementation or dependencies are copied here.

## Files and boundaries

- `bundle/apps/outreach-console/`: browser modules, safe in-app dialogs and backend handlers.
- `bundle/apps/outreach-console/backend/ping.mjs`: startup-only fixed status with no keys, database or network access. It does not prove engine connectivity or authorization.
- `bundle/apps/outreach-console/requirements.json`: server-only API URL/token declarations matching the bundle manifest, preserved when the app directory is imported.
- `bundle/jobs/outreach-worker/code/run.mjs`: optional local one-pass CLI wrapper, with scheduling disabled by default.
- `bundle/skills/outreach.md`: suggested operating guidance. Importing the bundle has not been verified to register this as an active skill.
- `tests/contract.test.mjs`: dependency-free checks for the minimal adapter contracts.

The browser never receives the engine API token. Backend input allowlists, engine roles and approval hashes remain authoritative. The in-app confirmation dialog is ordinary UI, not trusted MCP/agent-host approval.

## Local setup

1. Use a disposable local test profile with no real audience. Build and initialize the external engine using its [README](https://github.com/splitintech/open-internal-tools/blob/13a7ffb75de3c5be017ce05d15e4115f191252d7/outreach-engine/README.md). Start its API on loopback with fake providers and live sending closed.
2. Import this example's `bundle/` directory into Papr. Keep the app private, cloud publishing disabled and the optional worker schedule disabled.
3. Configure `OUTREACH_API_URL` and `OUTREACH_API_TOKEN` in Papr's integration-key settings. Start with a viewer-role test token. Both are user-scoped, server-only declarations; never commit values.
4. Check read-only behavior and authorization failures before trying approval-capable test actions. Record the exact Papr version and OS.

`sync.cloudReady: false` and a local deployment profile express intent; they do not enforce deployment location or private access. A cloud backend's loopback address is not the user's computer. Do not publish this example to Papr Cloud as a workaround.

## Optional local job

The engine can run its worker independently instead. For the optional Papr job, configure these values in the **trusted local gateway process environment before starting it**. At the checked source baseline, the importer does not apply `jobs[].env`.

- `OUTREACH_CLI_ENTRY`: absolute path to a trusted, regular, non-symlink built `packages/outreach-cli/dist/bin.js`. The engine's separate workspace dependencies must remain available. No URLs or request/model-provided paths.
- `OUTREACH_DB`: absolute path to an existing, disposable initialized engine database.
- `OUTREACH_HOME`: optional absolute engine home. An existing `outreach.config.mjs` there is passed to the trusted CLI.
- `OUTREACH_WORKER_TIMEOUT_MS`: optional 100–300000 millisecond deadline, default 120000.

The imported command is `node code/run.mjs`, relative to the job root. The wrapper uses the current Node executable and explicit argv without a shell, runs one pass, suppresses child output, and does not install/download anything. On its own timeout or a received cancellation signal it terminates the child. Delivery of a Papr job cancellation through the host's shell/process layer is still unverified. Do not enable scheduling until the execution location and cancellation behavior are tested.

## Tests and current limits

With Node 24, from the Papr repository root:

```sh
node --test examples/outreach-console/tests/contract.test.mjs
```

The five dependency-free checks pass locally. The original adapter's broader tests and CI are in its [source repository](https://github.com/splitintech/open-internal-tools/commit/13a7ffb75de3c5be017ce05d15e4115f191252d7), not evidence that this example has run in Papr.

The source contract baseline is development commit `b34b6c4090adfb64109004d1a25645a3d3a2bd66`. Actual desktop import, full `validate_app`, UI/key provisioning, optional-job execution and host cancellation remain untested. The manifest's 2.6.0 minimum is a declaration, not a tested support floor. See [ACCEPTANCE.md](ACCEPTANCE.md) and [compatibility.json](compatibility.json). Early code review is welcome with these limitations; this is not presented as ready to merge or deploy.

## License

The external engine remains MIT-licensed. Original adapter code carries the retained [MIT copyright and permission notice](LICENSE); see [NOTICE.md](NOTICE.md). Contributions to Papr are submitted under its repository's AGPL-3.0 contribution terms. This example changes no Papr core code, package dependencies, workflows, default apps or community registry.
