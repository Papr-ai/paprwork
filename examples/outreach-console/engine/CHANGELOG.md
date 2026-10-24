# Changelog

## Unreleased (development version 0.0.0)

- Add local stdio MCP with a fixed ten-tool allowlist, strict input validation,
  untrusted-data result envelopes and trusted-host form confirmation.
- Add caller-bound, expiring, integrity-checked, single-use prepared operations
  and SQLite migration 0003. Preserve provider and live-send controls.
- Expand activation previews with template/sender/policy content and invalidate
  prepared activations when recipient personalization changes.
- Refuse activation or manual progression if the committing runtime lacks required
  unsubscribe configuration; never silently downgrade link-based messages.
- Prepare signed-tag OIDC publication, version/pack checks, package documentation
  and licenses, operations guidance, threat model and release checklist.
- Propose explicit Zoho automated-send exclusion based on current usage policy.

Not completed: actual Claude Code/Papr/mailbox acceptance, remote MCP OAuth/HTTPS,
separate Slack control app, release authorization, npm trusted-publisher setup,
version assignment, signed-tag publication or website deployment.
