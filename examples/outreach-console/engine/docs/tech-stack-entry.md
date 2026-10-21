# Proposed tech-stack entry (not published)

Title: Outreach Engine
Repository: https://github.com/splitintech/open-internal-tools/tree/main/outreach-engine
Package scope: @splitin/outreach-*
License: MIT
Status: Development; publication and live acceptance pending

Provider-neutral outreach orchestration with durable scheduling, human approvals,
suppression, reply/bounce/opt-out stops, at-most-once-without-confirmation recovery
and append-only audit. TypeScript/Node, SQLite, CLI, loopback HTTP, Papr Work console
and local stdio MCP. Gmail and Microsoft Graph reference adapters are exercised
against local API fakes. LinkedIn tasks are manual; Zoho automated sending is not
supported. Remote MCP and the separate Slack control app are not release-ready.

Publish this entry in the website's own repository only after the corresponding
engine release is authorized and verified. Do not advertise live production
acceptance or an npm installation command before the packages actually exist.
