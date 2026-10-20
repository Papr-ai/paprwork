# Review evidence and pending acceptance

This example is proposed for early code and placement review. Maintainers decide whether to accept it, request another location or decline an externally dependent example. Pending host tests are disclosed, not represented as complete.

## Verified locally

- Five dependency-free contract tests pass on Node 24: fixed ping with empty environment, unchanged protected handler/fail-closed actions, matching server-only requirements, preserved protected action declarations and corrected job-root command with disabled scheduling.
- The runtime files are identical to the reviewed source-repository adapter plus the three minimal compatibility corrections. Browser/runtime JavaScript is syntax-checked.
- No engine core, dependencies, credentials, contacts, database files or CI workflows are included.

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
