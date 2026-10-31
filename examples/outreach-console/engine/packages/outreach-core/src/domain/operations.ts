import { ulid, type ProviderPurpose, type SenderIdentity } from '@splitin/outreach-contracts';
import { providerContext } from '../execution/invoke';
import type { AccountRow } from '../execution/types';
import { ConflictError, NotFoundError, actorOf, audit, requireRole, type AuthContext, type Role } from './auth';
import type { DomainEnv, EnrollmentRow } from './env';
import { assertMaterializationRuntime, loadStepContext, materializeNext, stepIndex } from './materialize';
import { actionApprover } from './campaigns';
import { checkAccountHealth } from './health';
import { JurisdictionCode } from './jurisdictions';
import { addSuppression, normalizeEmail, stopEnrollment, type SuppressionInput } from './suppressions';

export function addPrincipal(env: DomainEnv, ctx: AuthContext, input: { externalRef: string; displayName: string; roles: Role[] }): string {
  requireRole(ctx, 'admin');
  return env.db.transaction(() => {
    const now = env.now();
    const id = ulid(now);
    env.db.prepare('INSERT INTO principals (id, workspace_id, external_ref, display_name, roles) VALUES (?,?,?,?,?)')
      .run(id, ctx.workspaceId, input.externalRef, input.displayName, JSON.stringify(input.roles));
    audit(env.db, ctx, now, 'principal', id, 'created', { externalRef: input.externalRef, roles: input.roles });
    return id;
  });
}

export interface RegisterAccountInput {
  readonly provider: string;
  readonly externalAccountId: string;
  readonly sender: SenderIdentity;
  /** Purposes the operator attests their contract with the provider allows. */
  readonly purposes: ProviderPurpose[];
  readonly secretRef: string;
  readonly webhookSecretRef?: string;
}

/** Registers a sending account and records the adapter's capability snapshot. Secrets are references only. */
export async function registerProviderAccount(env: DomainEnv, ctx: AuthContext, input: RegisterAccountInput): Promise<string> {
  requireRole(ctx, 'admin');
  if (!/^((env|keychain):[A-Za-z0-9_.-]+|file:[^\0\r\n]+)$/.test(input.secretRef)) {
    throw new Error('secretRef must look like env:NAME, keychain:NAME or file:PATH');
  }
  const adapter = env.adapters.get(input.provider);
  if (!adapter) throw new NotFoundError(`adapter ${input.provider}`);
  const id = ulid(env.now());
  const row: AccountRow = {
    id,
    workspace_id: ctx.workspaceId,
    provider: input.provider,
    external_account_id: input.externalAccountId,
    sender_identity: JSON.stringify(input.sender),
    purposes: JSON.stringify(input.purposes),
    capabilities: '{}',
    secret_ref: input.secretRef,
    webhook_secret_ref: input.webhookSecretRef ?? null,
    health: 'ok',
  };
  const capabilities = await adapter.account.discover(providerContext(env.exec, row, ctx.traceId, AbortSignal.timeout(30_000)));
  env.db.transaction(() => {
    const now = env.now();
    env.db.prepare(
      `INSERT INTO provider_accounts (id, workspace_id, provider, external_account_id, sender_identity, purposes, capabilities,
         secret_ref, webhook_secret_ref, health, health_checked_at) VALUES (?,?,?,?,?,?,?,?,?, 'ok', ?)`,
    ).run(id, ctx.workspaceId, input.provider, input.externalAccountId, row.sender_identity, row.purposes, JSON.stringify(capabilities), input.secretRef, row.webhook_secret_ref, now);
    audit(env.db, ctx, now, 'provider_account', id, 'registered', { provider: input.provider, purposes: input.purposes });
  });
  // Surface a wrong mailbox or a broken grant now, not at the first send.
  await checkAccountHealth(env, id);
  return id;
}

export interface ContactInput {
  readonly fullName: string;
  readonly firstName?: string;
  readonly title?: string;
  readonly email: string;
  readonly timezone?: string;
  readonly organization?: { name: string; domain?: string };
  readonly consentBasis: 'consent' | 'legitimate_interest' | 'existing_relationship' | 'unknown';
  /** ISO 3166 alpha-2 country of the recipient, when known (decision D5). */
  readonly jurisdiction?: string;
  readonly attributes?: Record<string, string>;
}

/** Adds a single contact by hand. Bulk import lives in @splitin/outreach-import. */
export function addContact(env: DomainEnv, ctx: AuthContext, input: ContactInput): string {
  requireRole(ctx, 'operator');
  return env.db.transaction(() => {
    const now = env.now();
    const email = normalizeEmail(input.email);
    if (env.db.prepare(`SELECT 1 FROM contact_points WHERE workspace_id = ? AND kind = 'email' AND value_norm = ?`).get(ctx.workspaceId, email)) {
      throw new ConflictError(`contact with ${email} already exists`);
    }
    let organizationId: string | null = null;
    if (input.organization) {
      const domain = input.organization.domain?.toLowerCase() ?? null;
      const existing = domain ? env.db.prepare('SELECT id FROM organizations WHERE workspace_id = ? AND domain_norm = ?').get<{ id: string }>(ctx.workspaceId, domain) : undefined;
      organizationId = existing?.id ?? ulid(now);
      if (!existing) env.db.prepare('INSERT INTO organizations (id, workspace_id, name, domain_norm) VALUES (?,?,?,?)').run(organizationId, ctx.workspaceId, input.organization.name, domain);
    }
    const contactId = ulid(now);
    env.db.prepare(
      `INSERT INTO contacts (id, workspace_id, organization_id, full_name, first_name, title, timezone, attributes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(contactId, ctx.workspaceId, organizationId, input.fullName, input.firstName ?? null, input.title ?? null, input.timezone ?? null, JSON.stringify(input.attributes ?? {}), now, now);
    env.db.prepare(
      `INSERT INTO contact_points (id, workspace_id, contact_id, kind, value_norm, value_raw, source, consent_basis, consent_at, jurisdiction, permitted_channels)
       VALUES (?,?,?,'email',?,?,'manual',?,?,?,'["email"]')`,
    ).run(ulid(now), ctx.workspaceId, contactId, email, input.email, input.consentBasis, now, input.jurisdiction === undefined ? 'unknown' : JurisdictionCode.parse(input.jurisdiction.trim().toUpperCase()));
    audit(env.db, ctx, now, 'contact', contactId, 'created', { source: 'manual' });
    return contactId;
  });
}

export function suppress(env: DomainEnv, ctx: AuthContext, input: Omit<SuppressionInput, 'workspaceId' | 'source'>): void {
  requireRole(ctx, 'operator');
  env.db.transaction(() => {
    const now = env.now();
    addSuppression(env.db, { ...input, workspaceId: ctx.workspaceId, source: `principal:${ctx.principalId}` }, now);
    audit(env.db, ctx, now, 'suppression', normalizeEmail(input.value), 'added', { scope: input.scope, reason: input.reason });
  });
}

export function setEnrollmentState(env: DomainEnv, ctx: AuthContext, enrollmentId: string, change: 'pause' | 'resume' | 'stop', reason: string): void {
  requireRole(ctx, 'operator');
  env.db.transaction(() => {
    const now = env.now();
    const row = env.db.prepare('SELECT * FROM enrollments WHERE workspace_id = ? AND id = ?').get<EnrollmentRow>(ctx.workspaceId, enrollmentId);
    if (!row) throw new NotFoundError(`enrollment ${enrollmentId}`);
    if (change === 'stop') {
      if (!stopEnrollment(env.db, enrollmentId, 'stopped', reason, actorOf(ctx), now)) throw new ConflictError(`enrollment is ${row.status}`);
    } else {
      const [from, to] = change === 'pause' ? ['active', 'paused'] : ['paused', 'active'];
      const result = env.db.prepare('UPDATE enrollments SET status = ?, row_version = row_version + 1, updated_at = ? WHERE id = ? AND status = ?').run(to ?? '', now, enrollmentId, from ?? '');
      if (result.changes !== 1) throw new ConflictError(`enrollment is ${row.status}`);
    }
    audit(env.db, ctx, now, 'enrollment', enrollmentId, change, { reason });
  });
}

/** Routes inbound notifications (replies, opt-outs, bounces, complaints) to a notification account, or turns them off. */
export function configureNotifications(env: DomainEnv, ctx: AuthContext, notifyAccountId: string | null): void {
  requireRole(ctx, 'admin');
  env.db.transaction(() => {
    const now = env.now();
    const row = env.db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(ctx.workspaceId);
    const settings = { ...(JSON.parse(row?.settings ?? '{}') as Record<string, unknown>), notifyAccountId };
    env.db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), ctx.workspaceId);
    audit(env.db, ctx, now, 'workspace', ctx.workspaceId, 'notifications_configured', { notifyAccountId });
  });
}

export interface ManualTaskRow {
  id: string;
  action_id: string;
  enrollment_id: string | null;
  channel: string;
  target_url: string | null;
  draft_text: string;
  status: 'open' | 'done' | 'skipped' | 'expired';
}

export function listManualTasks(env: DomainEnv, ctx: AuthContext, status: ManualTaskRow['status'] = 'open'): ManualTaskRow[] {
  requireRole(ctx, 'viewer');
  return env.db.prepare('SELECT * FROM manual_tasks WHERE workspace_id = ? AND status = ? ORDER BY created_at').all<ManualTaskRow>(ctx.workspaceId, status);
}

/** Only a human can complete a manual task (ADR 0003). Completion advances the enrollment. */
export function recordManualOutcome(env: DomainEnv, ctx: AuthContext, taskId: string, outcome: 'done' | 'skipped', note?: string): void {
  requireRole(ctx, 'operator');
  env.db.transaction(() => {
    const now = env.now();
    const task = env.db.prepare('SELECT * FROM manual_tasks WHERE workspace_id = ? AND id = ?').get<ManualTaskRow>(ctx.workspaceId, taskId);
    if (!task) throw new NotFoundError(`task ${taskId}`);
    if (task.status !== 'open') throw new ConflictError(`task is ${task.status}`);
    env.db.prepare('UPDATE manual_tasks SET status = ?, confirmed_by = ?, confirmed_at = ?, note = ? WHERE id = ?').run(outcome, ctx.principalId, now, note ?? null, taskId);
    audit(env.db, ctx, now, 'manual_task', taskId, outcome, { note: note ?? null });
    if (!task.enrollment_id) return;
    const sc = loadStepContext(env.db, task.enrollment_id);
    const step = env.db.prepare('SELECT step_id FROM scheduled_actions WHERE id = ?').get<{ step_id: string | null }>(task.action_id);
    if (sc && step) {
      assertMaterializationRuntime(env, ctx.workspaceId, sc.policy, sc.steps.slice(stepIndex(sc, step.step_id) + 1));
      materializeNext(env, sc, stepIndex(sc, step.step_id), now, actorOf(ctx), { requestActionApproval: actionApprover(env, ctx.workspaceId, ctx.principalId) });
    }
  });
}

