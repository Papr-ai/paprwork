# Threat model (development / 0.0.0)

## Assets and trust boundaries

Assets: mailbox authority, contact PII, suppression decisions, approved content,
provider receipts and the append-only audit trail. The local OS account and DB
administrator are trusted; a compromised host can replace code or database
contents and is outside the audit chain's prevention boundary. Hash chaining
provides evidence of tampering, not protection against a fully compromised host.

Untrusted inputs: imported files, contact attributes, mailbox messages, provider
HTTP responses, webhooks, MCP arguments and social-profile URLs. Remote callers
must never choose their authenticated principal/workspace through payload fields.
Papr is an optional client; its synced registry storage is not the engine database.

## Controls and verification

- Provider calls originate from scheduled actions, with claim/preflight/execute
  boundaries and uncertain outcomes. Failure injection and soak tests exercise
  recovery; neither mocks nor local tests prove a real provider's semantics.
- Live-send defaults to an empty allowlist. Jurisdiction policies, suppressions,
  approval hashes/expiry, health and kill switches are checked before sending.
- Imports are parsed inertly with byte/row limits and preview/hash-bound commit.
  CSV/XLSX expressions are not executed. MCP imports accept bounded inline text,
  not paths or URLs.
- HTTP is loopback by default. Database-backed tokens are hashed and role-capped;
  signed webhook verification precedes processing. Public hosting needs separate
  TLS/auth review and is not enabled by an MCP command.
- MCP exposes exactly the fixed tool list. Strict schemas reject identity and
  confirmation injection. Operations are durable, hash-bound, caller-bound,
  expiring and one-use. Host human confirmation precedes commit; roles are
  resolved again afterward. No worker/provider/kill-switch/secret tools exist.
- MCP results explicitly mark nested data as untrusted. Elicitation previews are
  also untrusted data, not instructions. This label does not replace a human's
  judgment; hosts must not automatically approve consequential tools.
- LinkedIn remains a human task. No login automation, challenge handling, scraping
  or social-message provider is part of this engine.
- Secret refs keep tokens out of SQLite. Provider redaction and owner-only grant
  files reduce accidental disclosure; keep logs and config out of public packages.

## Residual risks / release gates

Real mailbox acceptance and Papr-host acceptance are still required. Provider
terms and jurisdiction decisions are operator responsibilities, not permissions
the software can infer. Zoho must never advertise automated outreach.
Remote MCP OAuth tenant/audience registration, endpoint security and client
acceptance are unfinished; stdio does not imply remote readiness.

The Slack control app belongs in its separate product PR and needs mapped user
identity, signed-request validation, replay rejection and operation-bound buttons.
Notifier support is not evidence that Slack control is implemented.

Optional worker-driven backups and explicit admin-confirmed retention are described
in [maintenance](maintenance.md). Neither is enabled by default. Retention is partial
PII minimization, not full erasure; live operating procedures and deliverability
acceptance remain outstanding.
A database restore can forget sends; reconcile before resuming. Treat audit,
backups, staged import rows and manual-task text as sensitive operational data.

Report suspected credential exposure privately. Stop affected workers, revoke
credentials with the account owner and preserve evidence; never post secrets in
public issues. Do not weaken at-most-once recovery to improve apparent throughput.
