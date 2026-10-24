<p align="center">
  <img src="../docs/brand/splitin-logo.png" alt="SplitIn logo" width="96" height="96">
</p>

# Outreach Engine

MIT-licensed, provider-neutral outreach orchestration. It imports contacts, turns
versioned playbooks into per-contact scheduled actions, executes each action at most
once through capability-checked provider adapters, stops on reply, bounce, opt-out or
pause, and records every transition in an append-only audit log.

The engine is the product. The CLI, HTTP API, MCP server, Slack and the Papr Work app
are thin clients of it.

> **Status: M0–M7 complete, the D5 jurisdiction policy, the Gmail and Outlook adapters, Slack notifications and the health checker (M8).** Contracts, fakes, SQLite store, the durable execution core,
> the campaign domain, the importer, inbound processing, the `outreach` CLI, the HTTP API
> and the Papr Work console are built and tested on fake providers. Real provider adapters
> and Slack are M8, MCP is M9.
> Local M9 stdio MCP and M10 release preparation are now implemented in this working tree; external acceptance and publication are still pending.
> Nothing is emailed until an admin opens the live-send gate. Specification:
> [BUILD_PLAN.md](BUILD_PLAN.md), milestones in §14.

## Guarantees it is being built to

- **At most once without confirmation.** A send whose outcome is unknown is never
  repeated until the provider confirms it did not happen ([ADR 0002](docs/adr/0002-at-most-once-without-confirmation.md)).
- **Fail closed.** Unhealthy account, engaged kill switch, expired approval, suppressed
  recipient or unrenderable template all mean no send, with a recorded reason.
- **No social-network automation.** Social steps are manual tasks a human completes on
  the native site ([ADR 0003](docs/adr/0003-no-social-automation.md)).
- **No LLM in the send path.** Models may draft and suggest; deterministic code decides.

## Packages

| Package | Milestone | What it is |
| --- | --- | --- |
| `@splitin/outreach-contracts` | M0 seed, M1 | Types, schemas, action transition table, error taxonomy, provider ports |
| `@splitin/outreach-fakes` | M1 | Fake providers with failure modes + provider conformance kit |
| `@splitin/outreach-store-sqlite` | M2 | Migrations, repositories, audit hash chain |
| `@splitin/outreach-core` | M3–M4, M6 | Execution core, campaign domain, policy, inbound processing |
| `@splitin/outreach-import` | M5 | Inert HTML/CSV/XLSX/JSON importer |
| `@splitin/outreach-e2e` (private) | M6 | Import-to-audit end-to-end suite on fake providers |
| `@splitin/outreach-server` | M7 | HTTP API: bearer tokens, webhooks, one-click unsubscribe |
| `@splitin/outreach-cli` | M7 | The `outreach` command (setup, imports, campaigns, approvals, worker, serve) |
| `apps/papr` | M7 | Papr Work bundle: Outreach Console mini-app, worker job, agent skill |
| `@splitin/outreach-mcp` | M9 | MCP server |
| `@splitin/outreach-provider-email-gmail` | M8 | Gmail adapter: send as the mailbox user, Sent-folder reconciliation, History API inbound, loopback OAuth |
| `@splitin/outreach-provider-email-outlook` | M8 | Outlook / Exchange Online adapter via Microsoft Graph: MIME draft-then-send, Sent Items reconciliation, rotating refresh tokens |
| `@splitin/outreach-provider-kit` | M8 | Shared adapter building blocks: HTTP outcome classification, loopback OAuth (PKCE), DSN parsing |
| `@splitin/outreach-notify-slack` | M8 | Slack notifications: incoming webhook or `chat.postMessage`, escaped Block Kit |
| Zoho Mail adapter | M8 | Automated sending excluded by current provider policy; see proposed ADR 0005 |

## Develop

Requires Node ≥ 22.13.

```zsh
cd open-internal-tools/outreach-engine
npm install
npm run check   # lint, typecheck, test, package boundaries, secret scan, line limit
npm run build
```

`npm run boundaries` enforces the dependency direction in BUILD_PLAN.md §3: the core,
importer and adapters depend on `@splitin/outreach-contracts` only, and storage, HTTP,
MCP, Slack and file-parsing libraries are confined to the packages that own them. A new
package fails the check until it is given a rule.

## Decisions

Architecture decisions live in [docs/adr/](docs/adr/). Change a decision by adding a new
ADR that supersedes the old one, not by editing it.

## License

MIT. See [LICENSE](LICENSE).


## Remaining release gates

See [release preparation](docs/release.md), [operations runbook](docs/runbook.md),
[threat model](docs/threat-model.md) and [local MCP](packages/outreach-mcp/README.md).
Local tests do not complete live Gmail/Outlook, Papr or Claude Code acceptance.
The Slack control app is a separate `slack-agent-hq` PR. Remote MCP remains disabled
pending issuer/audience/hosting decisions. All packages remain development version
0.0.0, and no release tag, package publication or deployment is implied.
