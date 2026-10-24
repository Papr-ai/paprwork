import type { ProviderAdapter, SqlDatabase } from '@splitin/outreach-contracts';
import type { ExecutionDeps } from '../execution/types';

export interface UnsubscribeConfig {
  /** Public base URL, e.g. https://outreach.example.com/u/ (decision D3). */
  readonly baseUrl: string;
  /** HMAC secret for tokens; resolved once at startup, never stored in the database. */
  readonly secret: string;
  /**
   * Whether `baseUrl` is this engine's own POST /u/:token endpoint, so mail may advertise RFC 8058 one-click
   * (List-Unsubscribe-Post). Set false when the link opens a page instead (e.g. a hosted confirmation page):
   * a mailbox provider's one-click POST to a page would silently do nothing. Default true.
   */
  readonly oneClick?: boolean;
}

export interface DomainEnv {
  readonly db: SqlDatabase;
  readonly now: () => number;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly unsubscribe?: UnsubscribeConfig;
  /** Execution wiring, used by services that trigger worker-level operations (review resolution). */
  readonly exec: ExecutionDeps;
}

export interface CampaignVersionRow {
  id: string;
  campaign_id: string;
  version: number;
  sequence_version_id: string;
  provider_account_id: string;
  policy: string;
  policy_hash: string;
  audience: string;
  audience_hash: string | null;
  version_hash: string | null;
  approval_id: string | null;
  activated_at: number | null;
}

export interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  active_version_id: string | null;
  paused_reason: string | null;
}

export interface EnrollmentRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  campaign_version_id: string;
  contact_id: string;
  contact_point_id: string;
  status: 'active' | 'paused' | 'replied' | 'opted_out' | 'bounced' | 'completed' | 'stopped' | 'error';
  stop_reason: string | null;
  current_step_id: string | null;
  row_version: number;
}

export function loadCampaign(db: SqlDatabase, workspaceId: string, id: string): CampaignRow | undefined {
  return db.prepare('SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?').get<CampaignRow>(workspaceId, id);
}

export function loadVersion(db: SqlDatabase, id: string): CampaignVersionRow | undefined {
  return db.prepare('SELECT * FROM campaign_versions WHERE id = ?').get<CampaignVersionRow>(id);
}

export function loadEnrollment(db: SqlDatabase, id: string): EnrollmentRow | undefined {
  return db.prepare('SELECT * FROM enrollments WHERE id = ?').get<EnrollmentRow>(id);
}
