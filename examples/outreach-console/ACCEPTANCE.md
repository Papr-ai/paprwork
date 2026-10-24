# Review evidence and pending acceptance

This complete engine plus local adapter is proposed for early code and placement review. Maintainers decide whether to accept the larger scope, request another location or retain only an adapter. Pending host tests are disclosed, not represented as complete.

## Verified locally

- Five dependency-free contract tests pass on Node 24: fixed ping with empty environment, unchanged protected handler/fail-closed actions, matching server-only requirements, preserved protected action declarations and corrected job-root command with disabled scheduling.
- The runtime files are identical to the reviewed source-repository adapter plus the three minimal compatibility corrections. Browser/runtime JavaScript is syntax-checked.
- Every one of the 272 included engine files matches the pinned source Git blob and SHA-256 inventory. All 13 packages and the original app workspace, tests, docs, configuration and dependency lockfile are present.
- Credentials, contacts, database files, installed dependencies, generated outputs and CI workflows are excluded.
- Dependency-free source checks cover package boundaries, credential-shaped literals and significant-line limits. These are not a security audit or a substitute for the full suite.

## Prior engine evidence and relocation limits

The source commit `13a7ffb75de3c5be017ce05d15e4115f191252d7` passed [engine CI on Node 22 and 24](https://github.com/splitintech/open-internal-tools/actions/runs/39412219247), including build, lint, typecheck, unit/integration tests, boundaries, secret scan, line limits and fake-provider soak. This evidence applies to the byte-identical source at its original location.

The dependency install, build, full engine suite and soak have not been rerun in this nested location. Papr's full quality/test suite has not been run for this contribution. The engine stays a separate npm workspace and is not registered with Papr's root workspace or test runner. Source inspection indicates its build and test paths are self-contained; this is not an executed full-build result.

The outer `bundle/` remains the import target. The original `engine/apps/papr` workspace is preserved for reproducibility and does not include the three later outer-bundle compatibility corrections. See [SNAPSHOT.md](SNAPSHOT.md) for explicit differences and historical references that do not transfer with this source snapshot.

## Not yet verified in a running Papr host

- Clean bundle import and full `validate_app`, including all warnings.
- Browser module loading, in-iframe dialog accessibility/focus/cancel behavior and imported app-ID handling.
- Integration-key provisioning without leaking keys to the browser or logs.
- Real engine viewer/approver role behavior and exact/stale approval-hash checks through Papr.
- Local/private execution and independently disabled cloud publishing.
- Optional job import preserving its disabled schedule in the actual scheduler.
- Optional job success, errors, timeout and cancellation terminating its child through Papr's process layer.
- Skill registration, reimport/conflict handling, OS compatibility and the declared minimum version.

Use a disposable Papr profile, fake providers, synthetic contacts only, a separate test database and live sending closed for those checks. Record exact versions, commits and redacted evidence. Run the repository's contribution checks and relevant integration/manual tests before claiming merge readiness.

The source baseline is `b34b6c4090adfb64109004d1a25645a3d3a2bd66`; source-derived contract findings and standalone tests are not full host acceptance.
