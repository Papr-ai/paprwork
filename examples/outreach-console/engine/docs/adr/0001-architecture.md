# ADR 0001 — The engine is the product; surfaces are thin clients

- Status: Accepted
- Date: 2026-09-28

## Context

The original Papr Work GTM plan put the whole outreach domain inside one Papr mini-app
bundle, with workers as Papr jobs ticking over a shared SQLite database. Papr's jobs
guarantee that a run starts, not that an external effect inside it happens once;
interrupted runs are reconciled as failed. Papr has no MCP server, no Slack integration
and no email provider. The project is maintained by two people and rarely merges outside
PRs, so building inside Papr's core would make our roadmap depend on their review queue.

We also need the same behaviour from several places: a CLI, an HTTP API with webhook
ingress, an MCP server for Claude Code, Cursor and ChatGPT, Slack commands and approvals,
and the Papr Work UI.

## Decision

Build a standalone, provider-neutral engine in `outreach-engine/` as MIT packages:

- Application services hold every business rule. The CLI, HTTP API, MCP server, Slack
  app and Papr app call those services and implement no rules of their own.
- The store is the only source of truth. Every external effect originates from a
  `scheduled_actions` row; nothing calls a provider directly.
- Workers are idempotent functions of `(store, providers, clock)` exposed as
  `outreach worker --once | --loop`, so a Papr job, cron, systemd or launchd can host
  them without a daemon of ours.
- Identity and workspace come from the authenticated context, never from tool arguments
  or payloads. In Papr mode the workspace is Papr's workspace id.
- Papr is a host, not a dependency. No package imports Papr code.
- Dependency direction is enforced in CI by `scripts/check-package-boundaries.mjs`.

## Consequences

- SplitIn is not blocked on upstream. MIT code can be relicensed into Papr's AGPL core
  later if its maintainers ask for it.
- Papr jobs stop while the desktop sleeps, so production runs the standalone worker and
  uses Papr as a UI; the pilot may run inside Papr.
- Every surface needs its own auth mapping onto engine principals. This is intended: it
  keeps trust decisions explicit per surface.
