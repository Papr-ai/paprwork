# Outreach Engine — Build Plan

- Status: approved spec; implementation progress is tracked per milestone in §14
- Folder: `outreach-engine/` (MIT, SplitInTech open-internal-tools)
- Package scope: `@splitin/outreach-*`
- Runtime: TypeScript on Node ≥ 22.13 (first release with unflagged `node:sqlite`; Papr Work runs Node 24)
- Supersedes: `PAPRWORK_GTM_OUTBOUND_AND_OUTREACH_AUTOMATION_PLAN.md` for architecture. That plan still supplies product requirements; §17 lists exactly what was kept and what was dropped.
- Inputs: the Papr GTM technical audit and upstream review (2026-09-11), plus a re-verification against `Papr-ai/paprwork@faf6de5` (v2.6.18, 2026-09-27).

This document is the single source for building the whole thing. A contributor or agent should be able to pick any milestone in §14 and build it without reading anything else.

---

## 1. What we are building

We are building a provider-neutral outreach orchestration engine. It imports contacts, turns versioned playbooks into per-contact scheduled actions, sends each action at most once through capability-checked provider adapters, stops the sequence on a reply, bounce, opt-out or pause, and records every transition in an append-only audit log.

It ships as small npm packages plus three thin control surfaces: a CLI, an HTTP API with webhook ingress, and an MCP server. It also ships a Papr Work app that runs the engine through Papr's existing jobs and database extension surface.

The engine is the product. Papr, Slack and ChatGPT are clients of it.

### Why it lives here and not in Papr's core

Papr Work (`Papr-ai/paprwork`, AGPL-3.0) has no durable side-effect execution model. Its scheduler guarantees that a job run starts, and runs interrupted by a restart are reconciled as failed (`JobsService.ts:3627`). The project is effectively maintained by two people, and outside PRs are rare.

Building the engine here, under MIT, has three advantages. It unblocks SplitIn immediately. The code can be relicensed into AGPL later if the maintainers ask for it in core. And it can be distributed as a Papr app on the extension surface Papr already promotes (apps + jobs + registry databases, published through the Papr Cloud catalog) without needing their approval. The upstream track in §15 runs in parallel and never blocks this plan.

### Non-goals

These are permanent unless a later ADR changes them:

- Automated LinkedIn (or any social network) connection requests, DMs, scraping, or unattended browser actions. Social steps create **manual tasks** that a human completes on the native site.
- Stealth, anti-detection, or CAPTCHA/challenge/2FA handling of any kind.
- Using a provider for a purpose its terms exclude. For example, Zoho Mail's usage policy excludes automated and marketing mail, so its adapter only declares `manual_correspondence`.
- Claims of exactly-once delivery. We guarantee **at-most-once-without-confirmation**: a send whose outcome is unknown is never repeated until the provider confirms it did not happen.
- An LLM anywhere in the send path. LLMs may draft, summarize and suggest classifications. Deterministic code decides and executes.
- SplitIn personas, lists, copy, accounts or rules in this public folder (see §16).

---

## 2. Architecture

```text
             ┌─────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────┐
 surfaces    │ outreach CLI│  │ HTTP API +   │  │ MCP server │  │ Papr app +   │
             │             │  │ webhooks     │  │ stdio/HTTP │  │ Slack (HQ)   │
             └──────┬──────┘  └──────┬───────┘  └─────┬──────┘  └──────┬───────┘
                    └───────────────┬┴────────────────┴────────────────┘
                                    ▼
 core        ┌───────────────────────────────────────────────────────────────┐
             │ Application services (auth context → policy → domain → store) │
             │  import · campaign · approve · pause · status · manual tasks  │
             ├───────────────────────────────────────────────────────────────┤
             │ Workers (all idempotent, --once or --loop)                    │
             │  materializer · executor · lease sweeper · reconciler ·       │
             │  event processor                                              │
             └───────────────┬───────────────────────────────┬───────────────┘
                             ▼                               ▼
 storage     ┌───────────────────────────┐   ┌───────────────────────────────┐
             │ SQLite (WAL) via Store    │   │ Provider registry             │
             │ port; one file per install│   │ capability-checked adapters   │
             └───────────────────────────┘   └───────────────┬───────────────┘
                                                             ▼
 providers            email adapter · slack notifier · manual-task provider · fakes
```

Five rules hold everywhere:

1. **The store is the only source of truth.** Worker processes are disposable. Killing any process at any instruction must leave the system in a state the workers can recover from.
2. **Every external effect originates from a `scheduled_actions` row.** Nothing calls a provider directly: not surfaces, not agents, not Slack buttons.
3. **Identity and workspace come from the authenticated context**, never from tool arguments or request payloads.
4. **Surfaces are thin.** Business rules live in application services only. A rule implemented twice counts as a bug.
5. **Fail closed.** Missing capability, unhealthy account, engaged kill switch, expired approval, or an unrenderable template all result in no send and a recorded reason.

---

## 3. Repository layout

```text
outreach-engine/
  BUILD_PLAN.md                 this file
  README.md                     quick start (M0)
  package.json                  npm workspaces, private
  tsconfig.base.json
  vitest.config.ts
  eslint.config.js
  packages/
    outreach-contracts/         types, state tables, error taxonomy, capability model, SqlDatabase port, audit chain
    outreach-fakes/             fake email/notify/manual providers + provider conformance suite
    outreach-store-sqlite/      migrations + drivers implementing the SqlDatabase port (node:sqlite, better-sqlite3)
    outreach-core/              repositories (SQL against the port), services, policy, calendar, workers
    outreach-import/            HTML/CSV/XLSX/JSON staging importer
    outreach-notify-slack/      Slack incoming-webhook / chat.postMessage notifier
    outreach-provider-email-*/  reference email adapter (after decision D1)
    outreach-server/            HTTP API, webhook ingress, one-click unsubscribe endpoint
    outreach-mcp/               MCP server (stdio local, Streamable HTTP remote)
    outreach-cli/               `outreach` binary
  apps/
    papr/                       Papr Work app: UI, job definitions, skill markdown
  examples/
    playbooks/                  neutral example playbooks
    fixtures/                   synthetic leads on example.com / example.org
  docs/
    adr/                        0001-architecture.md, 0002-..., one decision per file
    threat-model.md
    runbook.md
    provider-authoring.md
    state-machines.md
```

Conventions copied from `verification-adapter-sdk/`, the closest sibling (contract + engine + adapters + server):

| Area | Convention |
|---|---|
| Build | `tsup` → ESM + CJS + `.d.ts` |
| Tests | Vitest; `fast-check` for property tests |
| Formatting | Strict TS, no `any`, ≤ 400 lines per file (Papr's 500-line rule, with headroom) |
| Dependencies | Enforced by `scripts/check-package-boundaries.mjs`. `contracts` depends on nothing internal; `core` depends on `contracts` plus the store port only; adapters depend on `contracts` only. |
| Publishing | OIDC via the existing `scripts/oidc-npm-publish.mjs` and a new `.github/workflows/outreach-engine-publish.yml`. Tag: `outreach-engine-v*`. |
| CI | `.github/workflows/outreach-engine.yml`: typecheck, lint, test, boundaries, secret scan. Fakes only, no live providers. |

### Dependencies (and why)

| Need | Choice | Reason |
|---|---|---|
| Schemas | `zod` | Papr and the MCP SDK already use zod; one schema language serves validation, MCP tool schemas and HTTP. |
| SQLite | `node:sqlite` default, `better-sqlite3` adapter | `node:sqlite` needs no native build and is what `slack-agent-hq` uses. `better-sqlite3` is what Papr/Electron already loads. |
| Time zones / business days | `luxon` | Correct IANA/DST handling; the calendar logic stays our own pure code on top. |
| CSV | `csv-parse` | Streaming, strict quoting, no evaluation. |
| XLSX | `exceljs` | Maintained on npm; reads cached values and never evaluates formulas. |
| HTML | `parse5` | Spec-compliant and inert: no script execution, no network, no DOM runtime. |
| HTTP | `hono` + `@hono/node-server` | Tiny, typed; gives raw-body access for signature verification. |
| MCP | `@modelcontextprotocol/sdk` | Official SDK, supports stdio and Streamable HTTP. |
| IDs | Built-in ULID (about 20 lines, `crypto.getRandomValues`) | Sortable IDs without a dependency. |

Anything not in this table needs an ADR.

---

## 4. Domain model

All tables are `STRICT`. Every row except `audit_events` carries `workspace_id`. In standalone mode the workspace is `default`. In Papr mode it is the Papr workspace id, never a new tenancy concept. Timestamps are epoch milliseconds in `INTEGER` columns. IDs are ULIDs stored as `TEXT`.

### 4.1 Identity and contacts

```sql
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;

CREATE TABLE principals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  external_ref TEXT NOT NULL,          -- "slack:T123:U456", "papr:user:…", "cli:local"
  display_name TEXT NOT NULL,
  roles TEXT NOT NULL,                 -- JSON array: viewer|operator|approver|admin
  UNIQUE (workspace_id, external_ref)
) STRICT;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, domain_norm TEXT,
  UNIQUE (workspace_id, domain_norm)
) STRICT;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id),
  full_name TEXT NOT NULL, first_name TEXT, title TEXT,
  timezone TEXT, locale TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',   -- JSON, playbook-specific fields
  merged_into_id TEXT REFERENCES contacts(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE contact_points (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  kind TEXT NOT NULL CHECK (kind IN ('email','social_profile','phone','other')),
  value_norm TEXT NOT NULL, value_raw TEXT NOT NULL,
  source TEXT NOT NULL,                    -- import batch id or "manual"
  consent_basis TEXT,                      -- consent|legitimate_interest|existing_relationship|unknown
  consent_evidence TEXT, consent_at INTEGER,
  jurisdiction TEXT,                       -- ISO 3166 code or 'unknown'
  permitted_channels TEXT NOT NULL DEFAULT '[]',
  UNIQUE (workspace_id, kind, value_norm)
) STRICT;
```

### 4.2 Import

```sql
CREATE TABLE mapping_profiles (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL,
  UNIQUE (workspace_id, name, version)
) STRICT;

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  source_name TEXT NOT NULL, source_sha256 TEXT NOT NULL, format TEXT NOT NULL,
  mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id),
  status TEXT NOT NULL CHECK (status IN ('previewed','committed','abandoned')),
  preview_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  counts TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, committed_at INTEGER,
  UNIQUE (workspace_id, idempotency_key)
) STRICT;

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id),
  locator TEXT NOT NULL,                   -- "csv:row=42" | "xlsx:Sheet1!A42" | "html:table[0]/tr[42]"
  raw TEXT NOT NULL, normalized TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('create','update','merge','reject','ambiguous')),
  errors TEXT NOT NULL DEFAULT '[]', contact_id TEXT
) STRICT;
```

### 4.3 Definitions (immutable once referenced)

```sql
CREATE TABLE templates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, version INTEGER NOT NULL,
  channel TEXT NOT NULL, subject TEXT, body_text TEXT NOT NULL, body_html TEXT,
  required_tokens TEXT NOT NULL,
  UNIQUE (workspace_id, name, version)
) STRICT;

CREATE TABLE sequence_versions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, version INTEGER NOT NULL,
  spec TEXT NOT NULL, spec_hash TEXT NOT NULL,     -- compiled playbook, §7
  UNIQUE (workspace_id, name, version)
) STRICT;

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL, external_account_id TEXT NOT NULL,
  sender_identity TEXT NOT NULL,           -- JSON: from name/address, postal address, reply-to
  purposes TEXT NOT NULL,                  -- JSON: subset of ProviderPurpose (§5.1), operator-attested
  capabilities TEXT NOT NULL,              -- JSON CapabilitySnapshot, refreshed by discover()
  secret_ref TEXT NOT NULL,                -- "env:NAME" | "keychain:NAME"; never the secret
  health TEXT NOT NULL CHECK (health IN ('ok','degraded','unhealthy','reauth_required')),
  health_checked_at INTEGER,
  UNIQUE (workspace_id, provider, external_account_id)
) STRICT;

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','paused','completed','archived')),
  active_version_id TEXT, paused_reason TEXT
) STRICT;

CREATE TABLE campaign_versions (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  version INTEGER NOT NULL,
  sequence_version_id TEXT NOT NULL REFERENCES sequence_versions(id),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  policy TEXT NOT NULL, policy_hash TEXT NOT NULL,
  audience_hash TEXT NOT NULL,
  activated_at INTEGER, activated_by TEXT,
  UNIQUE (campaign_id, version)
) STRICT;

CREATE TABLE audience_members (
  id TEXT PRIMARY KEY, campaign_version_id TEXT NOT NULL REFERENCES campaign_versions(id),
  contact_id TEXT NOT NULL, contact_point_id TEXT NOT NULL,
  eligibility TEXT NOT NULL,               -- JSON policy decision evidence at snapshot time
  UNIQUE (campaign_version_id, contact_id)
) STRICT;
```

### 4.4 Runtime

```sql
CREATE TABLE enrollments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL, campaign_version_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('active','paused','replied','opted_out','bounced','completed','stopped','error')),
  stop_reason TEXT, current_step_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,  -- optimistic concurrency
  enrolled_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_enrollment_live ON enrollments (workspace_id, campaign_id, contact_id)
  WHERE status IN ('active','paused');

CREATE TABLE scheduled_actions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  enrollment_id TEXT, campaign_id TEXT, step_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('email.send','email.reply','notify.publish','manual.task')),
  provider_account_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned','awaiting_approval','scheduled','claimed',
    'executing','succeeded','retryable','uncertain','reconciling','failed','cancelled','review')),
  due_at INTEGER NOT NULL, not_after INTEGER,
  payload TEXT NOT NULL,                   -- fully rendered, frozen content (§6.3)
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,           -- stable across attempts
  rfc_message_id TEXT,                     -- generated by us for email kinds
  approval_id TEXT,
  lease_owner TEXT, lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error_class TEXT, state_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
) STRICT;
CREATE INDEX ix_actions_due ON scheduled_actions (state, due_at);
CREATE INDEX ix_actions_enrollment ON scheduled_actions (enrollment_id, state);

CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES scheduled_actions(id),
  attempt_no INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('pending','succeeded','rejected_retryable','rejected_permanent','uncertain')),
  error_class TEXT, error_detail TEXT,     -- redacted
  receipt TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
  UNIQUE (action_id, attempt_no)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  provider_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL, provider_thread_id TEXT,
  rfc_message_id TEXT, in_reply_to TEXT, references_ids TEXT NOT NULL DEFAULT '[]',
  from_addr TEXT NOT NULL, to_addrs TEXT NOT NULL, subject TEXT,
  at INTEGER NOT NULL, action_id TEXT, enrollment_id TEXT,
  UNIQUE (provider_account_id, provider_message_id)
) STRICT;
CREATE INDEX ix_messages_rfc ON messages (rfc_message_id);
CREATE INDEX ix_messages_thread ON messages (provider_account_id, provider_thread_id);

CREATE TABLE provider_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider_account_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processed','ignored','failed','review')),
  received_at INTEGER NOT NULL, processed_at INTEGER,
  UNIQUE (provider_account_id, provider_event_id)
) STRICT;

CREATE TABLE provider_cursors (
  provider_account_id TEXT PRIMARY KEY, cursor TEXT, overlap_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE manual_tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL, target_url TEXT, draft_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','done','skipped','expired')),
  confirmed_by TEXT, confirmed_at INTEGER, note TEXT
) STRICT;
```

### 4.5 Safety and audit

```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('action','batch','campaign_version')),
  subject_id TEXT NOT NULL, operation_hash TEXT NOT NULL,
  preview TEXT NOT NULL,
  requested_by TEXT NOT NULL, decided_by TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('pending','approved','rejected','revoked','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, consumed_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE suppressions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global','channel','provider_account','domain')),
  channel TEXT NOT NULL DEFAULT '*', value_norm TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN
    ('opt_out','hard_bounce','complaint','manual','do_not_contact','legal')),
  source TEXT NOT NULL, effective_at INTEGER NOT NULL,
  UNIQUE (workspace_id, scope, channel, value_norm)
) STRICT;

CREATE TABLE kill_switches (
  workspace_id TEXT NOT NULL,              -- '*' for global
  scope TEXT NOT NULL CHECK (scope IN ('global','workspace','provider_account','campaign')),
  target_id TEXT NOT NULL,
  engaged INTEGER NOT NULL, reason TEXT, engaged_by TEXT, engaged_at INTEGER,
  PRIMARY KEY (workspace_id, scope, target_id)
) STRICT;

CREATE TABLE rate_buckets (
  workspace_id TEXT NOT NULL, scope_key TEXT NOT NULL,   -- "account:<id>:day" | "domain:acme.com:day" | "recipient:<cp>:gap"
  window_start INTEGER NOT NULL, used INTEGER NOT NULL, limit_value INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, scope_key, window_start)
) STRICT;

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL, at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,                -- principal|worker|provider|system
  actor_id TEXT NOT NULL, source TEXT NOT NULL, trace_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
  action TEXT NOT NULL, detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL   -- sha256(prev_hash || canonical(row))
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
```

A hash chain costs almost nothing, and `outreach audit verify` can prove the log was not edited. Retention pruning uses a separate, audited `archive` path that exports a signed segment first; it never deletes in place.

---

## 5. Contracts (`@splitin/outreach-contracts`)

### 5.1 Capabilities and purpose

```ts
export type ProviderPurpose =
  | 'manual_correspondence' // a human-initiated one-to-one message
  | 'transactional'
  | 'automated_outreach'    // scheduled one-to-one B2B sequences
  | 'marketing'
  | 'bulk';

export interface CapabilitySnapshot {
  provider: string;
  purposes: ProviderPurpose[];         // what the provider's terms permit, declared by the adapter
  send: boolean;
  replyInThread: boolean;
  customHeaders: boolean;              // can we set Message-ID / List-Unsubscribe?
  externalIdempotency: boolean;        // provider dedupes on our key
  inboundWebhook: boolean;
  mailboxPolling: boolean;
  reconcileBySentSearch: boolean;
  maxRecipientsPerMessage: number;
  discoveredAt: number;
}
```

A campaign may activate only if `campaign.purpose ∈ adapter.purposes ∩ account.purposes`. The adapter declares what the provider's terms allow; the operator attests what their contract allows. Both must agree.

### 5.2 Provider ports

```ts
export interface ProviderContext { workspaceId: string; account: ProviderAccountRef; secrets: SecretResolver; traceId: string; signal: AbortSignal; }

export interface AccountPort {
  discover(ctx: ProviderContext): Promise<CapabilitySnapshot>;
  health(ctx: ProviderContext): Promise<{ status: 'ok' | 'degraded' | 'unhealthy' | 'reauth_required'; detail?: string }>;
}

export interface EmailSender {
  send(ctx: ProviderContext, a: ApprovedEmail): Promise<SendResult>;
  reconcile(ctx: ProviderContext, a: UncertainEmail): Promise<ReconcileResult>;
}

export interface MailboxReader {
  readChanges(ctx: ProviderContext, cursor: string | null): Promise<{ events: InboundMailEvent[]; nextCursor: string }>;
}

export interface WebhookVerifier {
  verify(rawBody: Uint8Array, headers: Headers, secret: string, now: number): Promise<VerifiedEvent[] | 'reject'>;
}

export interface NotificationPublisher { publish(ctx: ProviderContext, n: Notification): Promise<SendResult>; }

export type SendResult =
  | { kind: 'accepted'; receipt: ProviderReceipt }
  | { kind: 'rejected'; errorClass: ErrorClass; retryAfterMs?: number; detail: string }
  | { kind: 'unknown'; detail: string };            // timeout/reset after bytes left the process

export type ReconcileResult =
  | { kind: 'found'; receipt: ProviderReceipt }
  | { kind: 'absent' }                              // provider affirms it was not sent
  | { kind: 'still_unknown'; detail: string };

export interface ProviderReceipt {
  providerMessageId: string; providerThreadId?: string; rfcMessageId?: string;
  acceptedAt: number; raw?: Record<string, string>; // ids only, never bodies or tokens
}
```

### 5.3 Error taxonomy

Adapters map every failure into one of these classes. The engine decides what happens based on the class alone; no provider-specific logic lives in the core.

| `ErrorClass` | Engine behaviour |
|---|---|
| `auth_expired` | Refresh once under a per-account lock. If confirmed, retry; if not, set account `reauth_required` and hold its actions. |
| `auth_revoked` / `forbidden` | Permanent failure. Account `unhealthy`. Pause the campaign and notify. |
| `rate_limited` | `retryable`, honoring `retryAfterMs`; tighten the account bucket. |
| `invalid_recipient` / `hard_bounce` | Permanent failure. Add a suppression, set the enrollment to `bounced`. |
| `content_rejected` | Permanent failure. The action goes to `review`. |
| `policy_blocked` / `complaint` | Engage the account kill switch. Operator review is required before resuming. |
| `transient` (5xx, reset before send) | `retryable` with full-jitter backoff, capped at 15 minutes. |
| `unsupported` | Permanent failure. Never fall back to another adapter or channel. |

### 5.4 Manual tasks

```ts
export interface ManualTaskProvider {
  prepare(ctx: ProviderContext, input: { channel: string; targetUrl?: string; draft: string }): Promise<{ taskId: string }>;
}
// Only a principal can complete a task: recordManualOutcome(taskId, 'done' | 'skipped', note).
// No code path marks a manual task done on its own.
```

### 5.5 Conformance kit

`@splitin/outreach-fakes/conformance` exports `runEmailSenderConformance(factory)`. Every adapter must pass it in CI against a recorded or sandbox double. It checks:

- ID stability: the receipt has the same `providerMessageId` whenever `reconcile` finds a message.
- Errors map into `ErrorClass` with no raw provider strings leaking.
- `unknown` is returned for post-send timeouts.
- `reconcile` never returns `absent` unless the provider can affirm it.
- Honoring `retryAfterMs`.
- No secrets in thrown errors or receipts.

---

## 6. Execution core — the heart

### 6.1 Action state machine

```text
planned ──(needs approval)──▶ awaiting_approval ──approved──▶ scheduled
   │                                 └──rejected/expired──▶ cancelled
   └──(no approval needed)──────────────────────────────────▶ scheduled
scheduled ──claim──▶ claimed ──preflight ok──▶ executing
claimed ──preflight defers (window/budget)──▶ scheduled (new due_at)
claimed ──preflight blocks (paused/suppressed/replied/kill)──▶ cancelled
claimed ──lease expired──▶ scheduled                 (no attempt started: safe)
executing ──accepted──▶ succeeded
executing ──rejected retryable──▶ retryable ──backoff──▶ scheduled
executing ──rejected permanent──▶ failed
executing ──unknown──▶ uncertain
executing ──lease expired──▶ uncertain               (attempt may have run: never assume)
uncertain ──▶ reconciling ──found──▶ succeeded
                          ──absent──▶ scheduled (if attempts remain) | failed
                          ──still_unknown ×N──▶ review
any non-terminal except executing ──cancel (reply/opt-out/pause/kill)──▶ cancelled
```

Terminal states are `succeeded`, `failed`, `cancelled` and `review` (review exits only by human decision). Transitions live in one table in `contracts` (`ACTION_TRANSITIONS`). The store rejects any transition not in the table. A property test generates random event sequences and asserts that no path reaches a second provider call without an intervening `absent` or `rejected`.

### 6.2 Why `claimed` and `executing` are separate

This split is what fixes the original plan's deduplication bug. `claimed` means a worker holds the lease but has not committed to acting; a crash here is harmless, and the action simply returns to `scheduled`. `executing` is written, together with an `action_attempts(pending)` row, in a committed transaction **before** the provider call. A crash after that point can only lead to `uncertain`, never to a blind resend.

### 6.3 Content is frozen before approval

The materializer renders the template with the contact's attributes when it creates the action. It stores the complete payload (from, to, subject, text, html, headers, attachment digests), computes `content_hash = sha256(canonical(payload))`, and generates `rfc_message_id = <ulid.action@sender-domain>`. Approval binds that hash. Editing a template creates a new template version; existing actions keep their frozen payload unless explicitly re-materialized, which invalidates their approvals. A missing required token means the action is never created, the enrollment goes to `error`, and a reason is recorded.

### 6.4 Executor tick

```text
claim(N):
  BEGIN IMMEDIATE
    SELECT id FROM scheduled_actions
      WHERE state='scheduled' AND due_at<=:now ORDER BY due_at LIMIT :N
    UPDATE … SET state='claimed', lease_owner=:worker, lease_expires_at=:now+lease
  COMMIT

for each claimed action:
  PREFLIGHT  (BEGIN IMMEDIATE … COMMIT)
    assert lease_owner = me AND lease not expired
    kill switches: global, workspace, provider_account, campaign      → cancel/hold
    campaign.status = active; enrollment.status = active             → cancel
    suppression match (global, channel, account, domain) on recipient → cancel + enrollment stopped
    not_after passed                                                  → cancel(expired)
    approval (if required): approved, unexpired, hash = content_hash  → else awaiting_approval
    account.health = ok; capability permits kind + campaign purpose   → else hold (state_reason)
    send window (recipient tz, business calendar)                     → reschedule to next slot
    reserve rate buckets: account/day, domain/day, campaign/day, recipient gap
                                                                      → exhausted: reschedule to reset
    INSERT action_attempts(pending); state='executing'; attempt_count+=1; audit
  CALL provider with idempotency_key, rfc_message_id, AbortSignal(timeout)
  RESULT  (BEGIN IMMEDIATE … COMMIT)
    accepted  → attempt succeeded, message(outbound), action succeeded, advance enrollment (§7.3)
    retryable → release rate reservation, state retryable → scheduled(due_at=backoff)
    permanent → state failed; apply class effects (§5.3)
    unknown   → attempt uncertain, state uncertain (keep rate reservation)
    every branch → audit + notify.publish action if the policy asks for it
```

"Hold" means the action stays `scheduled` with `due_at` pushed forward and a `state_reason`. Held actions show in the UI as blocked, with a reason, not as failures.

### 6.5 Other workers

| Worker | Cadence | Job |
|---|---|---|
| Lease sweeper | Every executor tick | `claimed` with expired lease → `scheduled`; `executing` with expired lease → `uncertain`. |
| Reconciler | Every 5 min | `uncertain` → `reconciling` → adapter `reconcile()` searching by `rfc_message_id`, then idempotency key, then recipient + time window. Applies found/absent/still_unknown; after 3 × `still_unknown` → `review`. |
| Materializer | Every tick | Due step transitions and activation fan-out create actions (§7.3). |
| Event processor | Every tick | `provider_events(pending)` → classify → correlate → apply (§8). |
| Health checker | Every 15 min | `AccountPort.health()`; updates `provider_accounts.health`. |

Each worker is a pure function of `(store, providers, clock)` and runs through `outreach worker --once|--loop`. `--once` exits after one pass of all due work. That lets a Papr job, a cron entry or a systemd timer host it with no daemon. `--loop` is for the standalone service.

### 6.6 Concurrency on SQLite

- WAL mode and `busy_timeout = 5000`.
- Every write transaction is `BEGIN IMMEDIATE`, so SQLite serializes writers.
- Claims batch at most `N = 25`, keeping transactions in single-digit milliseconds.
- Provider calls happen **outside** transactions.

Multiple worker processes on one file are safe. The test suite proves this by running 4 child processes against a single file with 10,000 actions and asserting zero double attempts.

For hosted or multi-node use, a Postgres store later implements the same port (`FOR UPDATE SKIP LOCKED` claims). It is not in scope until needed.

---

## 7. Playbooks, sequences and calendar

### 7.1 Playbook format

```yaml
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: b2b-introduction }
spec:
  purpose: automated_outreach
  audience: { importBatch: latest, require: [email], eligibility: [consent_or_legitimate_interest] }
  policy:
    approval: first_batch_then_campaign     # none | every_action | first_batch_then_campaign
    firstBatchSize: 20
    stopOn: [human_reply, opt_out, hard_bounce, complaint]
    window: { timezone: recipient, fallback: America/New_York, days: [Mon,Tue,Wed,Thu], start: "09:30", end: "16:30" }
    limits: { accountPerDay: 40, domainPerDay: 3, recipientMinGap: P3D }
  steps:
    - { id: intro,     type: email.send,  template: intro@1,     approval: inherit }
    - { id: wait1,     type: wait,        duration: P3D, calendar: business }
    - { id: followup,  type: email.reply, template: followup@1,  when: no_reply }
    - { id: social,    type: manual.task, channel: linkedin, template: social_note@1, when: no_reply }
    - { id: wait2,     type: wait,        duration: P4D, calendar: business }
    - { id: close,     type: email.reply, template: close@1,     when: no_reply }
```

### 7.2 Compilation rules

The playbook compiles into a `sequence_version` and a `campaign_version`. Compilation rejects:

- unknown step types;
- templates missing a token the audience cannot supply;
- `email.reply` with no prior `email.send`;
- a purpose not permitted by the account and adapter;
- a missing sender postal address when the policy requires one;
- `when` conditions other than `always | no_reply`;
- a social step of any type other than `manual.task`.

The output is deterministic, so identical input produces an identical `spec_hash`.

### 7.3 Enrollment progression

Actions are created one step at a time. The next action is created **in the same transaction** that marks the previous one `succeeded` (or, for waits, from `succeeded_at + duration` on the business calendar). A reply arriving during a wait therefore has only one pending action to cancel, and the `when: no_reply` check is evaluated at materialization time and again at preflight.

### 7.4 Calendar

`nextSlot(instant, window, holidays) → instant` is a pure function using luxon. It is property-tested across every IANA zone the fixtures use, both DST transitions, windows crossing midnight, and holiday runs. Business-day durations skip non-window days.

---

## 8. Inbound: replies, bounces, opt-outs

### 8.1 Ingestion

Two ingestion paths write into the same inbox:

- **Webhooks:** `POST /v1/webhooks/:provider/:accountId`. The raw body is verified by the adapter's `WebhookVerifier` (HMAC, with a 5-minute timestamp window) before parsing. Verified events are inserted into `provider_events` with `UNIQUE(provider_account_id, provider_event_id)`, which makes retries no-ops. The endpoint returns 200 before any processing happens.
- **Polling:** `MailboxReader.readChanges(cursor)` with an overlap window. Overlap duplicates collapse on the same unique key.

Both paths run when available: webhooks for latency, polling to fill gaps.

### 8.2 Classification (deterministic first)

| Signal | Class |
|---|---|
| `multipart/report; report-type=delivery-status`, status 5.x.x | `hard_bounce` |
| DSN with 4.x.x | `soft_bounce` (no stop; count it and stop after 3) |
| Provider feedback-loop / complaint event | `complaint` |
| `Auto-Submitted: auto-replied`, `X-Autoreply`, `Precedence: auto_reply`, OOO subject patterns | `auto_reply` (no stop; optional delay) |
| One-click unsubscribe hit, or a reply matching opt-out phrases | `opt_out` |
| Anything else correlated to an enrollment | `human_reply` |
| Uncorrelated, or a rule conflict | `review` |

An LLM may attach a suggested class and summary to `review` items. It never applies a class on its own.

### 8.3 Correlation order

1. `provider_thread_id` matches an outbound message on the same account.
2. `In-Reply-To` or any `References` id equals a stored outbound `rfc_message_id`.
3. Fallback: the sender equals an enrolled contact point and the message arrived within 30 days of our last outbound to them. This match is marked `weak`; a weak human reply still stops the enrollment (the safe direction) but also goes to review.

### 8.4 Stop is atomic

In one `BEGIN IMMEDIATE` transaction:

- set the enrollment status (`replied`, `opted_out`, `bounced`);
- cancel every action for that enrollment in `planned | awaiting_approval | scheduled | retryable | claimed`;
- insert a suppression when the class requires one;
- write an audit event;
- enqueue a `notify.publish` action.

An action already in `executing` cannot be recalled. That race window is bounded by one provider call, and it is the only one. It is documented in the runbook and measured in tests.

### 8.5 Unsubscribe

When `customHeaders` is available, email payloads include `List-Unsubscribe: <https://…/u/:token>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The body footer carries the same link. The token is an HMAC of `(workspace, contact_point, campaign)`, so no database lookup is needed to verify it. `POST /u/:token` writes a suppression immediately and returns 200. This requires a public URL (decision D3). Without one, the policy must fall back to "reply STOP" handling and the playbook declares it.

---

## 9. Policy, approvals, authorization

### 9.1 Roles

| Role | Can |
|---|---|
| `viewer` | Read status, previews, audit. |
| `operator` | Import, create drafts, pause, complete manual tasks. |
| `approver` | Approve or reject; resume after a kill switch. |
| `admin` | Manage accounts, kill switches, roles. |

A workspace can require separation of duties: the approver cannot be the principal who requested the approval. Bulk approvals (more than 50 actions) require the `approver` role, with no `operator` override.

### 9.2 Approval hashes

- **Action scope:** `content_hash`.
- **Batch scope:** `sha256(sorted(action.content_hash))`. Approving a batch approves exactly those actions and nothing added later.
- **Campaign-version scope:** `sha256(policy_hash, sequence spec_hash, audience_hash, all template versions)`. Approving covers every action materialized from that version, but only while every one of those hashes still matches.

Approvals expire (72 hours by default). Revocation takes effect at the next preflight.

### 9.3 Two-phase mutations (every surface)

```ts
prepare(op) → { operationId, preview, operationHash, requiresApproval, expiresAt, warnings }
commit({ operationId, operationHash, idempotencyKey }) → { status, affected, auditId }
```

`commit` re-derives the preview server-side and rejects on hash mismatch. Slack buttons, MCP tools and the Papr UI all use this flow; none of them has its own shortcut.

### 9.4 Kill switches

Engaging a kill switch takes one transaction: it flips the row, marks every affected `awaiting_approval` action as blocked with a reason, and audits the change. The executor checks kill switches during preflight, so actions already `claimed` stop at the next preflight. Resuming requires the `approver` role and a written reason.

---

## 10. Importer (`@splitin/outreach-import`)

Pipeline: `detect → parse (inert) → stage → map → normalize/validate → resolve duplicates → preview → commit`.

**Detection.** Formats are detected by magic bytes and extension. Limits: 25 MB and 100k rows by default. Encoding is sniffed (BOM, then UTF-8 validation, then Windows-1252 fallback), and a sniffed encoding produces a warning in the preview.

**Parsing is inert.**
- `parse5` for HTML, with `<table>` and repeated-card extraction by a mapping-profile selector (a small CSS subset implemented over the parse5 tree; no browser).
- `exceljs` for XLSX, reading cached values only and ignoring formulas and external links.
- `csv-parse` in strict mode.
- JSON/JSONL natively.

**Mapping profiles** are versioned JSON: `{ columns|selectors → canonical fields, transforms: trim|lower|split_name|url_canonical, required: [...] }`.

**Normalization rules:**
- Emails: lowercase the domain; the local part is preserved except for a case-fold on known case-insensitive providers.
- Profile URLs: canonical host, strip query and tracking parameters.
- Names: whitespace collapse only; no guessing.

**Duplicates.** Exact `contact_points` value matches produce `update`. The same name at the same organization domain with a different email produces `ambiguous`, which is never auto-merged.

**Preview.** The preview lists counts per outcome, up to 20 sample rows each, and all errors. `preview_hash = sha256(batch source_sha256, profile version, normalized rows)`.

**Commit.** A commit requires the matching `preview_hash` and an idempotency key. It creates contacts and contact points. It **never** creates enrollments.

**Export.** Any CSV export escapes cells starting with `= + - @ \t \r` (formula injection).

---

## 11. Surfaces

### 11.1 CLI (`outreach`)

```text
outreach init --db ./outreach.db
outreach migrate
outreach import preview <file> --profile <name@v>      → prints preview + hash
outreach import commit <batchId> --hash <h>
outreach playbook compile <file.yaml>                   → validation report
outreach campaign create --playbook <file> --account <id>
outreach campaign activate <id>                         → prepare/commit, may require approval
outreach approvals list | approve <id> --hash <h> | reject <id>
outreach pause|resume campaign|account|workspace <id>
outreach kill engage|release <scope> <id> --reason "…"
outreach tasks list | done <id> | skip <id>
outreach worker --once | --loop [--only executor,events,reconciler]
outreach status [campaign <id>]
outreach review list | resolve <id> --as sent|not_sent|ignore
outreach audit verify
```

The CLI principal is `cli:<os-user>` with admin rights on the local database. Remote surfaces never get this implicit trust.

### 11.2 HTTP API (`@splitin/outreach-server`)

`/v1` exposes resources that map one-to-one onto application services (`/imports`, `/campaigns`, `/operations/:id/commit`, `/approvals`, `/tasks`, `/status`, `/review`), plus `/v1/webhooks/*` and `/u/:token`.

- Auth: bearer tokens hashed in the database (an `api_tokens` table added in M7), each bound to a principal and scopes.
- The server listens on loopback by default. Binding a non-loopback address requires `--public` and TLS termination in front of it.
- Every response carries a `trace_id`.

### 11.3 MCP (`@splitin/outreach-mcp`)

The MCP server comes in two stages.

**Stage 1 — local stdio**, for Claude Code, Cursor and the `vscode-agent-router` peers. It uses the operator's identity, with no network exposure and no OAuth. It is cheap and useful immediately.

**Stage 2 — remote Streamable HTTP**, for ChatGPT. It requires public HTTPS and OAuth 2.1 as a protected resource. It reuses `outreach-server` auth, with tokens audience-bound to the MCP resource.

Tools are a fixed, deny-by-default list:

| Tool | Class |
|---|---|
| `outreach_status`, `outreach_campaign_get`, `outreach_approvals_list`, `outreach_review_list` | Read |
| `outreach_import_preview`, `outreach_campaign_prepare`, `outreach_sequence_preview` | Draft (no effect) |
| `outreach_commit` | Mutation. Needs `operationId` + `operationHash`, and the host must confirm. |
| `outreach_pause` | Mutation, safe direction, still two-phase. |
| `outreach_task_done` | Mutation, human-confirmed manual outcome. |

There is no tool that sends immediately, no tool that edits kill switches, and nothing touching the filesystem, shell or secrets. Tool descriptions state the exact effect. Everything returned from contacts or replies is marked as untrusted data in the tool result.

### 11.4 Slack

- **Notifications** (`@splitin/outreach-notify-slack`, M8) are `notify.publish` actions delivered through the same executor. They use an incoming webhook for a fixed channel or `chat.postMessage` when the destination varies. They get the same retry and uncertainty semantics as email, since a duplicated Slack ping is cheap but still counted.
- **Control:** a new app in `slack-agent-hq/apps/outreach`, as a separate PR per `CONTRIBUTING.md`. It uses the HQ's existing Slack plumbing plus signed-request verification (raw body, `v0` HMAC, 5-minute window) and acknowledges within 3 seconds, then processes asynchronously.
  - Commands: `/outreach status|preview|pause`.
  - Buttons carry only an opaque `operationId`. The click handler calls `commit` with the Slack user mapped to a `principals` row (`slack:<team>:<user>`); unmapped users are refused.

### 11.5 Papr Work app (`apps/papr`)

Papr is a host, not a dependency. The engine's packages never import Papr code.

| Papr primitive | Use |
|---|---|
| Own SQLite file (not a registry database) | `~/Papr/outreach/outreach.db`. Papr's synced registry databases block raw multi-statement writes, so the engine keeps its own file (ADR 0004). |
| `node` jobs | `outreach worker --once` every 1 min; `--only reconciler` every 5 min; `--only health` every 15 min. |
| Custom keys | Provider secrets injected as env vars. `secret_ref = env:NAME`. |
| Mini-app | Operator UI (below), calling the engine through its HTTP API bound to loopback, or directly through the app backend. |
| Skill markdown | `outreach.md`: teaches the agent to draft, preview and prepare, and never to commit without the user. |
| Browser | Manual tasks may open `target_url` in Papr Chrome. Opening is the only allowed browser action. |
| Workspace | `workspace_id` = the Papr workspace id. |

UI intent: the Today view is a timeline of everything scheduled to go out in the next 24 hours. Each item shows the recipient, the frozen preview, why it is waiting (window, budget, approval), and one control that stops it. Beside it sit the approval queue, the review queue (uncertain sends, ambiguous replies, weak matches), manual tasks, imports and health. It follows Papr's mini-app design system; no parallel design language.

**M7.0 spike (required before building):** confirm on Papr v2.6.18 how a job receives its registry database path (`jobDbProxyEnv.ts`, `jobSdkEnv.ts`), whether `node` jobs can run an npm binary, how custom keys arrive in the environment, and how local-only placement is declared. Done: the findings are in ADR 0004 (`docs/adr/0004-papr-host-integration.md`).

Papr jobs stop when the desktop sleeps. That is acceptable for a pilot. Production uses the standalone worker (`--loop` under systemd or launchd) with Papr as the UI only; both point at the same engine API.

---

## 12. Security

**Threat model (`docs/threat-model.md`).** Assets:
- provider tokens;
- contact PII;
- the ability to send as the operator;
- the audit log.

Entry points:
- imports (hostile files);
- webhooks (forgery, replay);
- HTTP/MCP (auth bypass, IDOR, prompt injection through contact or reply text);
- Slack (forged interactions);
- the local database file.

Controls:

- **Secrets:** only `secret_ref` values are stored, resolved at call time from env or the OS keychain, never logged. A redaction filter runs on every log line and error detail, and a test asserts that known token shapes never appear in logs, receipts or audit.
- **Egress:** adapters may only call their declared base URLs (checked by an allowlisted fetch wrapper; no user-controlled URLs reach fetch).
- **Webhooks:** raw-body verification before parsing, timestamp window, event-id dedupe, and a 1 MB size cap.
- **Transport:** HTTP binds loopback by default. Tokens are hashed at rest, scoped, and expire. Every mutation is two-phase and audited.
- **Isolation:** every repository function takes `workspaceId` from context and includes it in its `WHERE` clause. A test fixture with two workspaces asserts zero cross-reads on every service method.
- **Untrusted text:** contact attributes and inbound bodies are data. They go into templates only through escaping, and into MCP results only inside marked untrusted fields.
- **PII minimization:** inbound bodies are not stored by default (headers, ids and classification only). A configurable retention period prunes contact data for opted-out contacts, keeping only the suppression hash.
- **Live-send gate:** until decision D1 and legal sign-off are recorded, the executor refuses any recipient not in the workspace allowlist (exact addresses or domains). This is enforced in preflight, not in the UI. The gate cannot open until a signed-off jurisdiction policy exists (D5).

---

## 13. Testing

| Suite | What it must prove |
|---|---|
| Contracts | Transition table is closed; property test: no path to a second provider call without `absent`/`rejected`. |
| Store | Migrations up on an empty and a seeded database; constraint violations fire (live enrollment uniqueness, idempotency, event dedupe); audit triggers abort; hash-chain verify detects tampering. |
| Failure injection | Fake provider modes: `accept`, `reject_retryable`, `reject_permanent`, `unknown_after_accept`, `unknown_before_accept`, `rate_limited(retryAfter)`, plus crash hooks at every step boundary (after claim, after preflight commit, mid-call, before result commit). Assert final states and exact provider-call counts. |
| Concurrency | 4 processes × 10k actions on one file: zero duplicate attempts. Reply arriving during a claim: no send. Kill switch during a claim: no send. |
| Calendar | Property tests across time zones, DST and holidays. |
| Policy | Suppression precedence, purpose gating, approval hash invalidation on template edit, separation of duties, expiry, revocation. |
| Import | Hostile HTML (scripts, huge attributes, deep nesting), CSV formula cells, malformed quoting, 100k-row CSV under memory budget, XLSX with formulas/external links, mixed encodings, ambiguous duplicates, preview/commit hash mismatch. |
| Inbound | DSN parsing, OOO headers, thread/`References` correlation, weak matches → review, webhook forgery/replay/oversize rejected, poll overlap dedupe. |
| Surfaces | CLI golden output; HTTP auth/scope/IDOR; MCP tool list is exactly the allowlist, commit needs a hash, cross-workspace denied; Slack signature/replay/unmapped-user refusal. |
| End to end | Fake provider: import → compile → activate → approve first batch → sends → inbound reply → atomic stop → Slack notice → audit verify. Runs in CI in under 30 s. |
| Live (opt-in) | `OUTREACH_LIVE=1`, sandbox account, allowlisted internal recipients only; never in default CI. |

Performance budgets, checked in CI on the end-to-end fixture:
- `worker --once` cold start < 400 ms;
- RSS < 90 MB;
- claim + preflight + result overhead < 5 ms per action (excluding the provider call);
- 100k-row CSV preview < 10 s and < 250 MB.

---

## 14. Milestones

Each milestone is one PR inside `outreach-engine/`, is independently green, and leaves the system usable. Sizes: S = a few days, M = about a week, L = about two weeks, for one engineer working with agents.

| # | Milestone | Size | Contents | Acceptance |
|---|---|---|---|---|
| M0 | Scaffold + ADRs | S | Workspace, tsconfig, lint, vitest, boundaries/secret/line-limit scripts, CI workflow, README, ADR 0001 (architecture), 0002 (at-most-once-without-confirmation), 0003 (no social automation), and a seed `outreach-contracts` package so the pipeline builds and tests real code | CI green; each check proven to fail on a planted violation; ADRs merged. |
| M1 | Contracts + fakes | M | §5 types and zod schemas, `ACTION_TRANSITIONS`, error taxonomy, capability/purpose model, fake email/notify/manual providers with failure modes, conformance kit | Fakes pass their own conformance; transition property test green. |
| M2 | SQLite store | M | Driver port with `node:sqlite` + `better-sqlite3` adapters, migrations §4, repositories, audit chain, `audit verify` | Store suite green on both drivers. |
| M3 | Execution core | L | Claim, preflight, execute, result, lease sweeper, reconciler, review queue, rate buckets, kill switches, `worker --once/--loop` | Full failure-injection and concurrency suites green. **This is the milestone that must not be rushed.** |
| M4 | Campaign domain | L | Playbook compiler, templates + freezing, calendar, audience snapshot, activation, enrollment progression, approvals (three scopes), suppression, two-phase `prepare/commit`, roles | Policy + calendar suites; fake E2E up to "sends happen". |
| M5 | Importer | M | §10 in full, mapping profiles, CLI import commands | Import suite + performance budget. |
| M6 | Inbound | M | Provider event inbox, poll cursor, classification, correlation, atomic stop, unsubscribe token + `/u/:token` | Inbound suite; full fake E2E including reply stop. |
| M7 | Surfaces | M | CLI complete, HTTP server + tokens, M7.0 Papr spike → `apps/papr` jobs + skill + minimal UI | CLI/HTTP suites; Papr app runs the fake E2E on a desktop install. |
| M8 | Real providers | M | Mailbox adapters per D1 (Gmail, then Graph, then Zoho Mail) behind an `AccessTokenSource` port + conformance against a test mailbox; Papr unsubscribe app (D3); Slack notifier (Socket Mode); the Slack control app lands separately in `slack-agent-hq`. Done: jurisdiction policy (D5); Gmail and Outlook adapters + `outreach account connect gmail|outlook` + `file:` secrets (with write-back for rotated tokens); mailto List-Unsubscribe (D3); account health checker (§6.5); Slack notifier. Remaining: Zoho Mail adapter, Slack control app (separate PR in slack-agent-hq). | Adapter passes conformance; live opt-in run to the allowlist. |
| M9 | MCP | M | Stage 1 stdio; Stage 2 remote once D3/D4 are settled | MCP suite; handshake verified in Claude Code, and in ChatGPT for Stage 2. |
| M10 | Release | S | Publish workflow, versioned docs, runbook, threat model, hub README row, `splitin.net/tech-stack` entry | Signed tag publishes `@splitin/outreach-*` through OIDC. |

Critical path: M0 → M1 → M2 → M3 → M4 → M6 → M8. M5 can run in parallel after M2. M7 can start after M4. M9 comes after M7.

**Pilot readiness** means M0–M8 are done, decisions D1–D3 are recorded, legal sign-off exists for the target jurisdictions and message class, and the live-send allowlist is lifted by an admin through an audited action.

---

## 14.1 Working-tree completion update (2026-10-20)

This update does not mark external acceptance as completed.

- M9 Stage 1: local stdio control surface, fixed ten-tool allowlist, durable
  caller/hash-bound 15-minute prepared operations, trusted host form confirmation,
  strict inputs and untrusted result envelopes. CLI does not load provider
  credentials or execute workers. Actual Claude Code acceptance remains pending.
- M9 Stage 2: no listener or permissive auth placeholder. D4 issuer/audience and
  HTTPS hosting decisions, OAuth implementation and real ChatGPT acceptance remain.
- M10 preparation: tag-verified OIDC workflow, coordinated-version/pack checks,
  package licenses and READMEs, runbook, threat model, release checklist and hub row.
  Maintainer version assignment, trusted-publisher setup, protected environment,
  signed tag, publication and separate website entry remain pending.
- M8: proposed ADR 0005 clarifies that current Zoho Mail policy excludes scheduled
  automated sends even if labeled manual correspondence. No Zoho sender is shipped.
  Slack control remains a separate product PR; notification support is not control.
- Existing three PR acceptance gates remain open: ADR/build-plan/decision review,
  first allowlisted live Gmail/Outlook send, and live Papr bundle acceptance.
- Dependency-review run 36539594167 failed before assessment with a dependency
  graph/feature availability error. The public repository is eligible according
  to GitHub documentation, but current feature settings need admin verification.
  The check has not been disabled or treated as a successful security assessment.

---

## 15. Upstream track (Papr Work) — parallel, non-blocking

| Step | What | When |
|---|---|---|
| U1 | Privately disclose to the maintainers (email or GitHub private security advisory; not a public issue): gateway default bind `0.0.0.0` (`src/gateway/index.ts:198`); plaintext `cookies.json` session storage (`PlatformSessionService.ts:697,1363`); empty allowlist returns every tool (`ToolRegistry.ts:80-83`). Offer patches. | Now |
| U2 | Open a short issue (text in Appendix A). One question: outreach primitives in core, or an app on the extension surface? | After M3 is demoable |
| U3 | Tiny docs/CI PR: `CONTRIBUTING.md` targets a nonexistent `develop` branch; CI never runs `npm run check`, so the 500-line rule is unenforced. | Any time |
| U4 | If the maintainers want it in core: port `contracts` + the execution core as small PRs under `src/gateway/services/outreach/`, relicensed into AGPL (our MIT code allows this). Otherwise publish `apps/papr` to the Papr Cloud catalog. | After their answer |

Papr's own LinkedIn automation (the social-media-auth skill, `papr_platform_browser.py`) is their decision. Our proposal simply excludes social automation from scope; we don't frame it as a policy lecture.

---

## 16. SplitIn private layer (never in this repo)

The private repository `splitintech/splitin-outreach-config` holds:

- mapping profiles for SplitIn's HTML/CSV lead lists;
- personas and eligibility rules;
- playbooks and templates (copy, signatures, postal address);
- account wiring (`secret_ref` names only);
- Slack channel and principal mappings;
- jurisdiction and legal-basis decisions;
- suppression seeds;
- reporting definitions.

It consumes the published `@splitin/outreach-*` packages through their CLI, API and playbook format only; no fork. Secrets live in the host's env or keychain, never in either repo.

---

## 17. Traceability to the original plan

| Original plan item | Disposition |
|---|---|
| Import → validate → enroll → execute → detect replies → stop → report | Kept (§6–§10) |
| Leads / sequences / steps / templates / enrollments / events / suppressions / mail accounts / runtime settings | Replaced by §4 (adds contact points, versions, actions/attempts, messages, provider events, approvals, audit, tenancy) |
| `MailConnector` single interface | Split into ports (§5.2) |
| Tick + insert-before-send dedupe | Replaced by the claimed/executing split and reconciliation (§6) |
| Subject/from reply search | Replaced by thread/RFC correlation (§8.3) |
| Zoho + SMTP as v1 adapters | Mailbox adapters per D1 (Gmail, Graph, Zoho Mail); each adapter declares `automated_outreach` only after a review of that provider's terms, otherwise `manual_correspondence`. Zoho Campaigns excluded for cold outreach. |
| LinkedIn connect/DM workers, warm-up caps | Dropped; `manual.task` only |
| Slack incoming webhook digest | Kept as the notifier; control moves to a signed Slack app |
| Optional MCP client | Dropped for now; an MCP **server** is what ChatGPT needs (§11.3) |
| Mini-app screens, first-run wizard, "no send-10k button", capacity shown before enroll | Kept (§11.5) |
| Kill switch, caps, quiet hours, circuit breakers, approve first N | Kept and made transactional (§6.4, §9) |
| Dry-run CI with fakes, opt-in live E2E | Kept (§13) |
| Runbook, metrics | Kept → `docs/runbook.md`; metrics in §18 |
| Upstream PR-A…F | Replaced by §14 here and §15 upstream |

---

## 18. Operations and metrics

`outreach status` and the UI expose:

- queue depth by state;
- oldest due age (lag);
- claim expiries;
- attempt outcomes (succeeded / retryable / uncertain);
- review-queue size and age;
- reply latency (inbound received → enrollment stopped);
- suppression hits at preflight;
- bounce and complaint rates per account (breaker: 5% hard bounces over the last 100 sends, or any complaint, engages the account kill switch);
- approval age;
- webhook verification failures.

The runbook covers:

- expired auth;
- rate-limit blocks;
- an uncertain-send backlog;
- webhook outage (polling covers it);
- a bounce spike;
- a suspected duplicate (use `audit verify` and the attempts timeline);
- a reply-stop miss;
- restoring from backup (SQLite `VACUUM INTO` snapshots, taken daily by the worker).

---

## 19. Decisions

Principle (2026-09-28): **build on what Papr Work already provides wherever its guarantees are enough, and own only what they are not.** Evidence for every Papr claim below: `Papr-ai/paprwork@faf6de5`, read-only review.

| ID | Decision | Status | Blocks |
|---|---|---|---|
| D1 | **Mailbox adapters: Gmail API, then Microsoft Graph (Outlook), then Zoho Mail.** Send as the rep, from a secondary warmed domain, 30-50 cold emails per inbox per day. Replies are polled from the same mailbox; "did it send?" reconciliation searches Sent by `Message-ID`. Graph sends via draft-then-send so a message id exists. **Zoho Campaigns is rejected for cold outreach:** its anti-spam policy requires permission-based lists (fine for opted-in audiences only). Each adapter declares `automated_outreach` only after a review of that provider's acceptable-use terms; otherwise it is limited to `manual_correspondence`. Adapters take access tokens from an `AccessTokenSource` port so the grant can later come from Papr's planned server-side connectors (`docs/CONNECTORS_PLUGINS_ROADMAP.md`, not shipped; Papr removed desktop Google OAuth in 2026-09). Until then: our own Google Cloud app, user type **Internal** to the Workspace (no Google verification). | Decided | M8 |
| D2 | **Worker runs as a Papr job, `local-only`.** Papr's cloud scheduler is live (`SYNC_V3_DISPATCH_PUSH`; `cloud-preferred` jobs run in a cloud sandbox), but the engine cannot use it yet: a cloud job's durable storage is Papr's synced databases, whose atomic `write-batch` appends to a workspace log and reports `changes: 1` per statement without executing guards (`TursoDbAdapter.ts`), at most 25 statements, no reads inside. The engine's claim step needs to know whether its guarded `UPDATE` matched; without that, at-most-once (ADR 0002) cannot hold. Cloud placement becomes possible if Papr confirms single-flight per job with fencing and read-after-write on the log (Appendix A, Q3), or exposes a transactional endpoint. A standalone `worker --loop` remains the option for teams that need sending while the Mac sleeps. | Decided for pilot; cloud pending Papr | Pilot |
| D3 | **No tunnel or VM.** Inbound is mailbox polling (D1). Unsubscribe (built): every message carries `List-Unsubscribe: <mailto:SENDER?subject=unsubscribe>`, so the mailbox provider's own Unsubscribe button mails the polled sending mailbox and the classifier applies an opt-out (suppression is by address, so it holds even without thread correlation); `List-Unsubscribe-Post` is only emitted when the link is the engine's own POST endpoint (`UnsubscribeConfig.oneClick`). Optional later: a footer link served by a small public Papr app on apps.papr.ai whose backend action writes one `INSERT` (token only) into a Papr database; the engine reads that table and applies each token after verifying its HMAC, so forged rows are inert. RFC 8058 machine one-click (`List-Unsubscribe-Post`) needs Papr to pass query parameters to backend actions (Appendix A, Q4); Google only mandates it above 5,000 messages/day to Gmail. Slack uses Socket Mode (no public URL). | Decided; unsubscribe app to verify on a live install | M8 |
| D4 | **Identity: Papr's Auth0 tenant.** Papr login (desktop and apps.papr.ai) is Auth0 PKCE. Papr has no MCP server or MCP client in this repo (an MCP bridge is optional milestone 4B, not built), so on Papr the agent path is the skill + CLI + backend actions already shipped in M7. Remote MCP (M9 stage 2, for Claude/ChatGPT clients) validates JWTs from Papr's Auth0 tenant if Papr registers the API (Appendix A, Q2); otherwise a separate Auth0 tenant. Stage 1 (stdio) needs neither. | Decided; stage 2 pending Papr | M9 stage 2 |
| D5 | **Per-country rules with recorded sign-off, enforced by the engine** (Papr has no compliance code). Built: `outreach jurisdiction set` records `allow` / `consent_required` / `block` per ISO country plus rules for unlisted and unknown countries, with who signed it off and where; admin-only and audited. Enforced at activation (excluded from the audience) and again before every send (cancelled, enrollment stopped). The live-send gate cannot open without it. Imports take a per-row `country` column (ISO code or English name). Which countries and message class the first campaign uses is still Legal's call. | Mechanism built; policy content pending Legal | Pilot |

---

## Appendix A — Upstream issue draft (U2)

> **Building an outreach app on Papr Work: four questions**
>
> We are building an MIT-licensed outreach engine (`splitintech/open-internal-tools/outreach-engine`) as a Papr app: versioned sequences, a durable action queue with leases and explicit "uncertain" states (no blind resends after timeouts), reply/bounce/opt-out stop, approvals bound to exact content. It ships a mini-app console (backend actions, server-side keys), a worker job and an agent skill. We want to use Papr's primitives rather than duplicate them, and need four answers:
>
> 1. **Connectors:** will the planned server-side connectors (CONNECTORS_PLUGINS_ROADMAP.md) expose Gmail and Microsoft Graph access tokens to apps and jobs, and roughly when?
> 2. **Identity:** can a third-party API (a remote MCP server) accept access tokens from Papr's Auth0 tenant, i.e. would you register it as an API/audience?
> 3. **Cloud jobs:** for `cloud-preferred` jobs, does the scheduler run lease guarantee single-flight per job with fencing, and does a run see all workspace-log writes from the previous run (read-after-write)? Is there, or could there be, a write batch that returns real `changes` and aborts on a failed guard?
> 4. **Public backend actions:** could `/api/app/backend/:action` pass URL query parameters to the handler (needed for RFC 8058 one-click unsubscribe POSTs, which carry the token only in the URL)?
>
> Separately, we found three security issues and will report them privately first. Social-network automation is out of scope. Happy to demo.

## Appendix B — Example fixtures

Fixtures use only `example.com`, `example.org`, `example.net` and generated names. `examples/fixtures/leads-100.csv` uses the header below. `examples/fixtures/leads-hostile.html` and `leads-formulas.xlsx` exist for the security suites.

```csv
email,profile_url,full_name,first_name,org_name,org_domain,title,timezone,attr.segment
```


### Local maintenance implementation note

Optional worker-triggered `VACUUM INTO` backups and explicit hash-confirmed admin
retention batches are implemented; see `docs/maintenance.md` for exact scope,
default-off configuration, migration compatibility, restore risks and exclusions.
Retention is intentionally partial PII minimization, not full erasure or the
literal removal of every copy except a hash. Immutable audit records are not
pruned or edited; a signed audit-archive lifecycle remains separate work.
