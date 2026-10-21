# Papr local integration acceptance

## Evidence boundaries

This bundle remains **preflight only**. Local tests exercise the engine HTTP API with fake providers, backend subprocess format, frontend modules with a minimal DOM test double, local worker wrapper with fake CLI processes, declared local-only intent and significant-line checks. They do not launch Papr.

On 2026-10-20, the manifest was also checked separately against unmodified Papr `BundleManifestSchema` at development `b34b6c4090adfb64109004d1a25645a3d3a2bd66`. That schema accepted it. The isolated upstream native-dialog linter found two errors in the original UI and none after the in-app dialog replacement. This is not the full `AppService.validateApp` result. No upstream source is vendored here. Exact source identifiers are in `../compatibility.json`.

## Live desktop gate (all pending)

Use a fresh Papr profile/install, fake providers, a disposable engine database and no real audience. Keep live sending closed. Record version, OS, branch/commit, date and redacted logs/screenshots.

- [ ] Import from a local bundle folder completes without dependency-install failure.
- [ ] App opens; every relative browser module loads; correct imported app ID is sent.
- [ ] Full `validate_app` completes. Record all errors and warnings, rather than treating the isolated lint as equivalent.
- [ ] Key injection works and the API token never appears in browser requests, static assets or logs.
- [ ] Overview handles loading, empty, data and unreachable-engine states.
- [ ] Viewer token cannot mutate. Intended approver-role actions succeed only with proper engine authorization and exact approval hash; stale/incorrect hashes fail.
- [ ] Review decisions, task outcomes, campaign pause/resume and workspace kill switch work against safe test data.
- [ ] In-app dialog is visible in the Papr iframe; Tab/Shift+Tab remain inside it, Escape/Cancel/back navigation do not act, Enter on Cancel does not approve, repeated clicks do not open competing dialogs, and focus returns after dismissal or background refresh.
- [ ] Empty or whitespace-only provider message ID cannot record a sent decision.
- [ ] App remains local/private. Cloud auto-publish is disabled independently of descriptive manifest metadata.
- [ ] Optional job has its schedule disabled, configured absolute CLI/DB paths and verified local execution. One fake-provider pass finishes; missing entry/DB, cancellation, timeout and nonzero CLI exit are accurately reported.
- [ ] Canceling or timing out the Papr job actually terminates the child CLI; no sends or child process remain running.
- [ ] Verify how the optional agent skill is registered. Its presence in the bundle alone does not grant or constrain authorization.
- [ ] Reimport/conflict handling and a fresh profile preserve safe defaults; all claimed operating systems/minimum versions have actual evidence or explicit limitations.

Only update `fullHostValidation` and minimum-version claims after this evidence exists. Do not tick unchecked cases from schema/unit-test results.

## Upstream PR gate

1. Obtain maintainer agreement on repository/path/scope. No community registry listing PR. Keep the engine and unrelated maintenance changes out of Papr core.
2. Start from current `development`, not the stale guide's nonexistent `develop`. Recheck the guide and pending process/CI updates before submission.
3. Run Papr's `npm run check`, `npm run test`, manual dev testing and relevant E2E/build checks on the candidate. The current CI equivalent is Node 24, `npm ci`, `npm rebuild better-sqlite3`, then `npm run test:sequential -- --tier=ci`. Rebuild native modules for Electron again before desktop execution when needed.
4. Record baseline upstream failures separately from patch regressions. Current CI is not automatically triggered for development until that workflow change lands.
5. Open a draft PR only after placement agreement, with the linked issue, scope, installation/rollback steps, screenshots, exact test evidence and any unresolved acceptance gaps. Maintainer review/merge remains separate.

Official references: [core contribution guide](https://github.com/Papr-ai/paprwork/blob/b34b6c4090adfb64109004d1a25645a3d3a2bd66/CONTRIBUTING.md), [community guide](https://github.com/Papr-ai/paprwork-community-apps/blob/12fae6e6a4d5a367236c78bd701b876a404958e3/CONTRIBUTING.md), [test workflow](https://github.com/Papr-ai/paprwork/blob/b34b6c4090adfb64109004d1a25645a3d3a2bd66/.github/workflows/test.yml).
