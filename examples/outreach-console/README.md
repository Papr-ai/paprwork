# Outreach engine and local Papr Console example

**Draft contribution for maintainer review.** This now includes the complete standalone outreach engine alongside the local Papr adapter. Placement under `examples/outreach-console` is provisional, not an established Papr extension point. Nothing is installed into Papr's runtime, enabled by default, added to its root workspace or published to a community registry.

The browser console shows upcoming actions, approvals, review items, manual tasks and campaign status. Seven fixed backend actions call the separately running [included engine](engine/README.md). Its database, provider integrations and authorization remain outside Papr's process. The engine source and its dependency lockfile are included; installed dependencies, databases, credentials and live audiences are not.

## Files and boundaries

- `engine/`: all 272 tracked files from the canonical outreach-engine source at `13a7ffb75de3c5be017ce05d15e4115f191252d7`, byte-for-byte. Includes all 13 packages, the original app workspace, tests, docs, npm lockfile, build and checking scripts.
- `SOURCE-SNAPSHOT.json` and `SNAPSHOT.md`: exhaustive hashes, provenance, relocation caveats and the update procedure.
- `bundle/apps/outreach-console/`: browser modules, safe in-app dialogs and backend handlers.
- `bundle/apps/outreach-console/backend/ping.mjs`: startup-only fixed status with no keys, database or network access. It does not prove engine connectivity or authorization.
- `bundle/apps/outreach-console/requirements.json`: server-only API URL/token declarations matching the bundle manifest, preserved when the app directory is imported.
- `bundle/jobs/outreach-worker/code/run.mjs`: optional local one-pass CLI wrapper, with scheduling disabled by default.
- `bundle/skills/outreach.md`: suggested operating guidance. Importing the bundle has not been verified to register this as an active skill.
- `tests/contract.test.mjs`: dependency-free checks for the minimal adapter contracts.

**Import `bundle/`, not `engine/apps/papr/bundle/`.** The latter is the unmodified source workspace retained so the original engine's tests and history remain reproducible. This outer bundle is the authoritative Papr example and adds the startup ping, app-local key requirements and corrected job command. The duplication is intentional and recorded in [SNAPSHOT.md](SNAPSHOT.md), not two interchangeable distributions.

The browser never receives the engine API token. Backend input allowlists, engine roles and approval hashes remain authoritative. The in-app confirmation dialog is ordinary UI, not trusted MCP/agent-host approval.

## Local setup

1. Use a disposable local test profile with no real audience. Follow the standalone build commands below, then the engine's [operations runbook](engine/docs/runbook.md). Initialize only a disposable database; use fake providers, bind the API to loopback and keep live sending closed.
2. Import this example's `bundle/` directory into Papr. Keep the app private, cloud publishing disabled and the optional worker schedule disabled.
3. Configure `OUTREACH_API_URL` and `OUTREACH_API_TOKEN` in Papr's integration-key settings. Start with a viewer-role test token. Both are user-scoped, server-only declarations; never commit values.
4. Check read-only behavior and authorization failures before trying approval-capable test actions. Record the exact Papr version and OS.

`sync.cloudReady: false` and a local deployment profile express intent; they do not enforce deployment location or private access. A cloud backend's loopback address is not the user's computer. Do not publish this example to Papr Cloud as a workaround.

### Standalone engine development

Use Node 24 and npm 10+; install only in the nested engine directory, never by adding it to Papr's root package.json:

```sh
cd examples/outreach-console
node scripts/verify-engine-snapshot.mjs
cd engine
npm ci
npm run build
npm run check
npm run soak
```

These are reproduction instructions, not a claim they were rerun after relocation. Installing dependencies can use the network and execute package lifecycle scripts. The included engine is development version 0.0.0, not a release. Its build/check scripts resolve paths within this standalone workspace. Historical source-repository publication instructions do not configure or authorize publishing from Papr.

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
node --test examples/outreach-console/tests/*.test.mjs
```

The five adapter contract checks and the snapshot checks run without engine dependencies. The engine's broader tests and CI passed in its [source repository at the exact included commit](https://github.com/splitintech/open-internal-tools/actions/runs/39412219247). That is prior source evidence, not a new full-engine run after relocation or evidence that this example has run in Papr. Papr's own test commands do not automatically run this nested workspace's tests.

The source contract baseline is development commit `b34b6c4090adfb64109004d1a25645a3d3a2bd66`. Actual desktop import, full `validate_app`, UI/key provisioning, optional-job execution and host cancellation remain untested. The manifest's 2.6.0 minimum is a declaration, not a tested support floor. See [ACCEPTANCE.md](ACCEPTANCE.md) and [compatibility.json](compatibility.json). Early code review is welcome with these limitations; this is not presented as ready to merge or deploy.

## License

The original engine and adapter code retain their [MIT copyright and permission notice](LICENSE), including the exact notices inside `engine/`; see [NOTICE.md](NOTICE.md). This contribution is submitted under Papr's AGPL-3.0 contribution terms. No Papr core code, root dependencies, workflows, default apps or community registry are changed.
