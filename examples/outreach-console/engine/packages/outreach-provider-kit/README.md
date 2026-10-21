# @splitin/outreach-provider-kit

Shared building blocks for outreach provider adapters: JSON HTTP with send-outcome classification, loopback OAuth (PKCE), delivery-status parsing.

Development version 0.0.0; not yet a published release. Requires Node 22.13+.
See the [engine README](../../README.md), [build plan](../../BUILD_PLAN.md),
[runbook](../../docs/runbook.md) and [release gates](../../docs/release.md).

Build from the workspace root with `npm run build`; verify with `npm run check`.
The engine keeps human approval, suppression and live-send gates in the core.
Do not call provider send methods outside the durable execution pipeline.

MIT license.
