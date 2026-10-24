/**
 * Initial schema (BUILD_PLAN.md §4). All tables are STRICT; every owned row carries workspace_id;
 * timestamps are epoch milliseconds; ids are ULIDs. Invariants live in constraints, not app code.
 */
export const SCHEMA_0001 = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE principals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  external_ref TEXT NOT NULL, display_name TEXT NOT NULL, roles TEXT NOT NULL,
  UNIQUE (workspace_id, external_ref)
) STRICT;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, domain_norm TEXT,
  UNIQUE (workspace_id, domain_norm)
) STRICT;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  organization_id TEXT REFERENCES organizations(id),
  full_name TEXT NOT NULL, first_name TEXT, title TEXT, timezone TEXT, locale TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  merged_into_id TEXT REFERENCES contacts(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_contacts_name ON contacts (workspace_id, full_name);

CREATE TABLE contact_points (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  kind TEXT NOT NULL CHECK (kind IN ('email','social_profile','phone','other')),
  value_norm TEXT NOT NULL, value_raw TEXT NOT NULL, source TEXT NOT NULL,
  consent_basis TEXT CHECK (consent_basis IN ('consent','legitimate_interest','existing_relationship','unknown')),
  consent_evidence TEXT, consent_at INTEGER, jurisdiction TEXT,
  permitted_channels TEXT NOT NULL DEFAULT '[]',
  UNIQUE (workspace_id, kind, value_norm)
) STRICT;
CREATE INDEX ix_contact_points_contact ON contact_points (contact_id);

CREATE TABLE mapping_profiles (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL,
  UNIQUE (workspace_id, name, version)
) STRICT;

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_name TEXT NOT NULL, source_sha256 TEXT NOT NULL, format TEXT NOT NULL,
  mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id),
  status TEXT NOT NULL CHECK (status IN ('previewed','committed','abandoned')),
  preview_hash TEXT NOT NULL, idempotency_key TEXT,
  counts TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, committed_at INTEGER,
  UNIQUE (workspace_id, idempotency_key)
) STRICT;

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id),
  ordinal INTEGER NOT NULL, locator TEXT NOT NULL, raw TEXT NOT NULL, normalized TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('create','update','merge','reject','ambiguous')),
  errors TEXT NOT NULL DEFAULT '[]', contact_id TEXT,
  UNIQUE (batch_id, ordinal)
) STRICT;

CREATE TABLE templates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, version INTEGER NOT NULL, channel TEXT NOT NULL,
  subject TEXT, body_text TEXT NOT NULL, body_html TEXT, required_tokens TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name, version)
) STRICT;

CREATE TABLE sequence_versions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, spec_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name, version),
  UNIQUE (workspace_id, spec_hash)
) STRICT;

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL, external_account_id TEXT NOT NULL,
  sender_identity TEXT NOT NULL, purposes TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '{}', secret_ref TEXT NOT NULL,
  webhook_secret_ref TEXT,
  health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','degraded','unhealthy','reauth_required')),
  health_detail TEXT, health_checked_at INTEGER,
  UNIQUE (workspace_id, provider, external_account_id)
) STRICT;

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','paused','completed','archived')),
  active_version_id TEXT, paused_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE campaign_versions (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  version INTEGER NOT NULL,
  sequence_version_id TEXT NOT NULL REFERENCES sequence_versions(id),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  policy TEXT NOT NULL, policy_hash TEXT NOT NULL, audience TEXT NOT NULL,
  audience_hash TEXT, version_hash TEXT, approval_id TEXT,
  activated_at INTEGER, activated_by TEXT,
  UNIQUE (campaign_id, version)
) STRICT;

CREATE TABLE audience_members (
  id TEXT PRIMARY KEY, campaign_version_id TEXT NOT NULL REFERENCES campaign_versions(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  contact_point_id TEXT NOT NULL REFERENCES contact_points(id),
  eligibility TEXT NOT NULL,
  UNIQUE (campaign_version_id, contact_id)
) STRICT;

CREATE TABLE enrollments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  campaign_version_id TEXT NOT NULL REFERENCES campaign_versions(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  contact_point_id TEXT NOT NULL REFERENCES contact_points(id),
  status TEXT NOT NULL CHECK (status IN
    ('active','paused','replied','opted_out','bounced','completed','stopped','error')),
  stop_reason TEXT, current_step_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  enrolled_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_enrollment_live ON enrollments (workspace_id, campaign_id, contact_id)
  WHERE status IN ('active','paused');
CREATE INDEX ix_enrollments_contact ON enrollments (workspace_id, contact_id, status);

CREATE TABLE scheduled_actions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  enrollment_id TEXT REFERENCES enrollments(id), campaign_id TEXT REFERENCES campaigns(id),
  step_id TEXT, contact_point_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('email.send','email.reply','notify.publish','manual.task')),
  purpose TEXT, provider_account_id TEXT REFERENCES provider_accounts(id), recipient_norm TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned','awaiting_approval','scheduled','claimed',
    'executing','succeeded','retryable','uncertain','reconciling','failed','cancelled','review')),
  due_at INTEGER NOT NULL, not_after INTEGER,
  payload TEXT NOT NULL, content_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  rfc_message_id TEXT, approval_id TEXT,
  lease_owner TEXT, lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  reconcile_count INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT, state_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
) STRICT;
CREATE INDEX ix_actions_due ON scheduled_actions (state, due_at);
CREATE INDEX ix_actions_enrollment ON scheduled_actions (enrollment_id, state);
CREATE INDEX ix_actions_approval ON scheduled_actions (approval_id);

CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES scheduled_actions(id),
  attempt_no INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('pending','succeeded','rejected_retryable','rejected_permanent','uncertain','confirmed_absent')),
  error_class TEXT, error_detail TEXT, receipt TEXT,
  reservations TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL, finished_at INTEGER,
  UNIQUE (action_id, attempt_no)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  provider_message_id TEXT NOT NULL, provider_thread_id TEXT,
  rfc_message_id TEXT, in_reply_to TEXT, references_ids TEXT NOT NULL DEFAULT '[]',
  from_addr TEXT NOT NULL, to_addrs TEXT NOT NULL, recipient_norm TEXT, subject TEXT,
  at INTEGER NOT NULL, action_id TEXT, enrollment_id TEXT,
  UNIQUE (provider_account_id, provider_message_id)
) STRICT;
CREATE INDEX ix_messages_rfc ON messages (rfc_message_id);
CREATE INDEX ix_messages_thread ON messages (provider_account_id, provider_thread_id);
CREATE INDEX ix_messages_recipient ON messages (workspace_id, recipient_norm, at);

CREATE TABLE provider_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  provider_event_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processed','ignored','failed','review')),
  class TEXT, correlation TEXT, enrollment_id TEXT, detail TEXT,
  received_at INTEGER NOT NULL, processed_at INTEGER,
  UNIQUE (provider_account_id, provider_event_id)
) STRICT;
CREATE INDEX ix_provider_events_status ON provider_events (status, received_at);

CREATE TABLE provider_cursors (
  provider_account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id),
  cursor TEXT, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE manual_tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  action_id TEXT NOT NULL UNIQUE REFERENCES scheduled_actions(id),
  enrollment_id TEXT, channel TEXT NOT NULL, target_url TEXT, draft_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','done','skipped','expired')),
  confirmed_by TEXT, confirmed_at INTEGER, note TEXT, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  scope TEXT NOT NULL CHECK (scope IN ('action','batch','campaign_version')),
  subject_id TEXT NOT NULL, operation_hash TEXT NOT NULL, preview TEXT NOT NULL,
  requested_by TEXT NOT NULL, decided_by TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('pending','approved','rejected','revoked','expired')),
  reason TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, consumed_count INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX ix_approvals_pending ON approvals (workspace_id, decision);

CREATE TABLE suppressions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  scope TEXT NOT NULL CHECK (scope IN ('global','channel','provider_account','domain')),
  channel TEXT NOT NULL DEFAULT '*', value_norm TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN
    ('opt_out','hard_bounce','complaint','manual','do_not_contact','legal')),
  source TEXT NOT NULL, effective_at INTEGER NOT NULL,
  UNIQUE (workspace_id, scope, channel, value_norm)
) STRICT;
CREATE INDEX ix_suppressions_value ON suppressions (workspace_id, value_norm);

CREATE TABLE kill_switches (
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global','workspace','provider_account','campaign')),
  target_id TEXT NOT NULL, engaged INTEGER NOT NULL CHECK (engaged IN (0,1)),
  reason TEXT, changed_by TEXT, changed_at INTEGER,
  PRIMARY KEY (workspace_id, scope, target_id)
) STRICT;

CREATE TABLE rate_buckets (
  workspace_id TEXT NOT NULL, scope_key TEXT NOT NULL, window_start INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK (used >= 0), limit_value INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, scope_key, window_start)
) STRICT;

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL, at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('principal','worker','provider','system')),
  actor_id TEXT NOT NULL, source TEXT NOT NULL, trace_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
  action TEXT NOT NULL, detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
) STRICT;
CREATE INDEX ix_audit_resource ON audit_events (resource_kind, resource_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`;
