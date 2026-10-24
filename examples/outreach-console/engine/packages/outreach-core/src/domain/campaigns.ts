import { digestCanonical, ulid, type SenderIdentity } from '@splitin/outreach-contracts';
import { ConflictError, ForbiddenError, NotFoundError, actorOf, audit, requireRole, type AuthContext } from './auth';
import { createApproval, createBatchApproval, loadApproval } from './approvals';
import { compileIssues } from './compile';
import { loadCampaign, type CampaignVersionRow, type DomainEnv } from './env';
import { assertMaterializationRuntime, loadStepContext, materializeNext } from './materialize';
import { PlaybookError, parsePlaybook, type Audience, type Policy, type Step } from './playbook';
import { jurisdictionVerdict, readJurisdictionPolicy } from './jurisdictions';
import { isSuppressed } from './suppressions';
import { findTemplate, type TemplateRow } from './templates';

export interface CreateCampaignInput {
  readonly name: string;
  readonly playbook: string | unknown;
  readonly providerAccountId: string;
}

export function createCampaign(env: DomainEnv, ctx: AuthContext, input: CreateCampaignInput): { campaignId: string; versionId: string } {
  requireRole(ctx, 'operator');
  const playbook = parsePlaybook(input.playbook);
  const issues = compileIssues(env, ctx.workspaceId, playbook, input.providerAccountId);
  if (issues.length) throw new PlaybookError(issues);
  const { db } = env;
  return db.transaction(() => {
    const now = env.now();
    const spec = { steps: playbook.spec.steps };
    const specHash = digestCanonical(spec);
    let sequence = db.prepare('SELECT id FROM sequence_versions WHERE workspace_id = ? AND spec_hash = ?').get<{ id: string }>(ctx.workspaceId, specHash);
    if (!sequence) {
      const latest = db.prepare('SELECT MAX(version) AS v FROM sequence_versions WHERE workspace_id = ? AND name = ?')
        .get<{ v: number | null }>(ctx.workspaceId, playbook.metadata.name);
      sequence = { id: ulid(now) };
      db.prepare('INSERT INTO sequence_versions (id, workspace_id, name, version, spec, spec_hash, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(sequence.id, ctx.workspaceId, playbook.metadata.name, (latest?.v ?? 0) + 1, JSON.stringify(spec), specHash, now);
    }
    const campaignId = ulid(now);
    const versionId = ulid(now);
    db.prepare(`INSERT INTO campaigns (id, workspace_id, name, purpose, status, created_at, updated_at) VALUES (?,?,?,?,'draft',?,?)`)
      .run(campaignId, ctx.workspaceId, input.name, playbook.spec.purpose, now, now);
    db.prepare(
      `INSERT INTO campaign_versions (id, campaign_id, version, sequence_version_id, provider_account_id, policy, policy_hash, audience)
       VALUES (?,?,1,?,?,?,?,?)`,
    ).run(versionId, campaignId, sequence.id, input.providerAccountId, JSON.stringify(playbook.spec.policy), digestCanonical(playbook.spec.policy), JSON.stringify(playbook.spec.audience));
    audit(db, ctx, now, 'campaign', campaignId, 'created', { name: input.name, playbook: playbook.metadata.name, specHash });
    return { campaignId, versionId };
  });
}

interface MemberCandidate {
  contact_id: string;
  contact_point_id: string;
  email: string;
  consent_basis: string | null;
  jurisdiction: string | null;
}

function draftVersion(env: DomainEnv, campaignId: string): CampaignVersionRow {
  const version = env.db
    .prepare('SELECT * FROM campaign_versions WHERE campaign_id = ? AND activated_at IS NULL ORDER BY version DESC LIMIT 1')
    .get<CampaignVersionRow>(campaignId);
  if (!version) throw new ConflictError('campaign has no draft version to activate');
  return version;
}

function candidates(env: DomainEnv, workspaceId: string, audience: Audience): MemberCandidate[] {
  const base = `SELECT c.id AS contact_id, cp.id AS contact_point_id, cp.value_norm AS email, cp.consent_basis, cp.jurisdiction
    FROM contacts c JOIN contact_points cp ON cp.contact_id = c.id AND cp.kind = 'email'
    WHERE c.workspace_id = ? AND c.merged_into_id IS NULL`;
  if (audience.source === 'all') return env.db.prepare(`${base} ORDER BY c.id`).all<MemberCandidate>(workspaceId);
  if ('importBatch' in audience.source) {
    return env.db
      .prepare(`${base} AND c.id IN (SELECT contact_id FROM import_rows WHERE batch_id = ? AND contact_id IS NOT NULL) ORDER BY c.id`)
      .all<MemberCandidate>(workspaceId, audience.source.importBatch);
  }
  const wanted = new Set(audience.source.contactIds);
  return env.db.prepare(`${base} ORDER BY c.id`).all<MemberCandidate>(workspaceId).filter((row) => wanted.has(row.contact_id));
}

export interface ActivationPreview {
  readonly operationId: string;
  readonly operationHash: string;
  readonly requiresApproval: boolean;
  readonly approvalId: string | null;
  readonly audienceCount: number;
  readonly excluded: { suppressed: number; noConsent: number; jurisdiction: number; alreadyEnrolled: number; duplicateContact: number };
  readonly sampleRecipients: readonly string[];
  readonly steps: readonly Step[];
  readonly templates: readonly TemplateRow[];
  readonly sender: SenderIdentity;
  readonly policy: Policy;
  readonly audienceHash: string;
}


function activationContent(env: DomainEnv, workspaceId: string, version: CampaignVersionRow, steps: readonly Step[]) {
  const templates = [...new Set(steps.flatMap((step) => 'template' in step ? [step.template] : []))]
    .map((ref) => {
      const template = findTemplate(env.db, workspaceId, ref);
      if (!template) throw new ConflictError('activation template no longer exists');
      return template;
    });
  const account = env.db.prepare('SELECT sender_identity FROM provider_accounts WHERE workspace_id = ? AND id = ?')
    .get<{ sender_identity: string }>(workspaceId, version.provider_account_id);
  if (!account) throw new NotFoundError('provider account');
  const sender = JSON.parse(account.sender_identity) as SenderIdentity;
  const contacts = env.db.prepare(`SELECT c.*, cp.value_norm, cp.consent_basis, cp.jurisdiction
    FROM audience_members a JOIN contacts c ON c.id = a.contact_id JOIN contact_points cp ON cp.id = a.contact_point_id
    WHERE a.campaign_version_id = ? AND c.workspace_id = ? ORDER BY a.contact_point_id`)
    .all(version.id, workspaceId);
  return { templates, sender, contacts };
}
function activationHash(version: CampaignVersionRow, steps: readonly Step[], content: ReturnType<typeof activationContent>, audienceHash: string) {
  return digestCanonical({ steps, policy: version.policy, audienceHash, account: version.provider_account_id, ...content });
}

/** Snapshots the audience, computes the exact version hash, and requests approval if the policy needs it. */
export function prepareActivation(env: DomainEnv, ctx: AuthContext, campaignId: string): ActivationPreview {
  requireRole(ctx, 'operator');
  const { db } = env;
  return db.transaction(() => {
    const now = env.now();
    const campaign = loadCampaign(db, ctx.workspaceId, campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${campaignId}`);
    if (campaign.status !== 'draft') throw new ConflictError(`campaign is ${campaign.status}`);
    const version = draftVersion(env, campaignId);
    const audience = JSON.parse(version.audience) as Audience;
    const excluded = { suppressed: 0, noConsent: 0, jurisdiction: 0, alreadyEnrolled: 0, duplicateContact: 0 };
    const lawPolicy = readJurisdictionPolicy(db, ctx.workspaceId);
    const members: MemberCandidate[] = [];
    const seenContacts = new Set<string>();
    for (const row of candidates(env, ctx.workspaceId, audience)) {
      if (seenContacts.has(row.contact_id)) {
        excluded.duplicateContact += 1;
        continue;
      }
      if (isSuppressed(db, ctx.workspaceId, row.email, version.provider_account_id)) excluded.suppressed += 1;
      else if (audience.eligibility.includes('consent_or_legitimate_interest') && !['consent', 'legitimate_interest', 'existing_relationship'].includes(row.consent_basis ?? '')) excluded.noConsent += 1;
      else if (!jurisdictionVerdict(lawPolicy, row.jurisdiction, row.consent_basis).ok) excluded.jurisdiction += 1;
      else if (db.prepare(`SELECT 1 FROM enrollments WHERE workspace_id = ? AND contact_id = ? AND status IN ('active','paused') LIMIT 1`).get(ctx.workspaceId, row.contact_id)) excluded.alreadyEnrolled += 1;
      else {
        members.push(row);
        seenContacts.add(row.contact_id);
      }
    }
    db.prepare('DELETE FROM audience_members WHERE campaign_version_id = ?').run(version.id);
    const insert = db.prepare('INSERT INTO audience_members (id, campaign_version_id, contact_id, contact_point_id, eligibility) VALUES (?,?,?,?,?)');
    for (const member of members) insert.run(ulid(now), version.id, member.contact_id, member.contact_point_id, JSON.stringify({ consent: member.consent_basis, jurisdiction: member.jurisdiction }));
    const audienceHash = digestCanonical(members.map((member) => member.contact_point_id).sort());
    const sequence = db.prepare('SELECT spec, spec_hash FROM sequence_versions WHERE id = ?').get<{ spec: string; spec_hash: string }>(version.sequence_version_id);
    const steps = (JSON.parse(sequence?.spec ?? '{"steps":[]}') as { steps: Step[] }).steps;
    const content = activationContent(env, ctx.workspaceId, version, steps);
    const { templates, sender } = content;
    const versionHash = activationHash(version, steps, content, audienceHash);
    const policy = JSON.parse(version.policy) as Policy;
    let approvalId: string | null = null;
    if (policy.approval !== 'none') {
      db.prepare(`UPDATE approvals SET decision = 'expired', decided_at = ? WHERE scope = 'campaign_version' AND subject_id = ? AND decision = 'pending'`).run(now, version.id);
      approvalId = createApproval(db, {
        workspaceId: ctx.workspaceId,
        scope: 'campaign_version',
        subjectId: version.id,
        operationHash: versionHash,
        preview: { campaign: campaign.name, audienceCount: members.length, excluded, steps: steps.map((s) => ({ id: s.id, type: s.type })), templates },
        requestedBy: ctx.principalId,
      }, now);
    }
    db.prepare('UPDATE campaign_versions SET audience_hash = ?, version_hash = ?, approval_id = ? WHERE id = ?').run(audienceHash, versionHash, approvalId, version.id);
    audit(db, ctx, now, 'campaign', campaignId, 'activation_prepared', { versionHash, audience: members.length, excluded });
    return {
      operationId: version.id,
      operationHash: versionHash,
      requiresApproval: approvalId !== null,
      approvalId,
      audienceCount: members.length,
      excluded,
      sampleRecipients: members.slice(0, 5).map((member) => member.email),
      steps, templates, sender, policy, audienceHash,
    };
  });
}

/** Activates exactly what was previewed (and approved): enrolls the snapshot and materializes first steps. */
export function commitActivation(env: DomainEnv, ctx: AuthContext, input: { campaignId: string; operationHash: string }): { enrolled: number; batchApprovalId: string | null } {
  requireRole(ctx, 'operator');
  const { db } = env;
  return db.transaction(() => {
    const now = env.now();
    const campaign = loadCampaign(db, ctx.workspaceId, input.campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${input.campaignId}`);
    if (campaign.status !== 'draft') throw new ConflictError(`campaign is ${campaign.status}`);
    const version = draftVersion(env, input.campaignId);
    if (!version.version_hash || version.version_hash !== input.operationHash) throw new ConflictError('preview is stale; prepare the activation again');
    const sequence = db.prepare('SELECT spec FROM sequence_versions WHERE id = ?').get<{ spec: string }>(version.sequence_version_id);
    const steps = (JSON.parse(sequence?.spec ?? '{"steps":[]}') as { steps: Step[] }).steps;
    const content = activationContent(env, ctx.workspaceId, version, steps);
    assertMaterializationRuntime(env, ctx.workspaceId, JSON.parse(version.policy) as Policy, steps);
    if (activationHash(version, steps, content, version.audience_hash ?? '') !== version.version_hash) throw new ConflictError('activation content changed; prepare again');
    const policy = JSON.parse(version.policy) as Policy;
    if (policy.approval !== 'none') {
      const approval = version.approval_id ? loadApproval(db, ctx.workspaceId, version.approval_id) : undefined;
      if (approval?.decision !== 'approved' || approval.operation_hash !== version.version_hash) throw new ForbiddenError('activation requires an approved campaign-version approval');
    }
    db.prepare(`UPDATE campaigns SET status = 'active', active_version_id = ?, updated_at = ? WHERE id = ?`).run(version.id, now, campaign.id);
    db.prepare('UPDATE campaign_versions SET activated_at = ?, activated_by = ? WHERE id = ?').run(now, ctx.principalId, version.id);
    const actor = actorOf(ctx);
    const batch = policy.approval === 'first_batch_then_campaign' ? { ids: [] as string[], size: policy.firstBatchSize } : undefined;
    const members = db.prepare('SELECT contact_id, contact_point_id FROM audience_members WHERE campaign_version_id = ? ORDER BY id')
      .all<{ contact_id: string; contact_point_id: string }>(version.id);
    let enrolled = 0;
    for (const member of members) {
      const enrollmentId = ulid(now);
      const inserted = db.prepare(
        `INSERT INTO enrollments (id, workspace_id, campaign_id, campaign_version_id, contact_id, contact_point_id, status, enrolled_at, updated_at)
         SELECT ?,?,?,?,?,?,'active',?,? WHERE NOT EXISTS (SELECT 1 FROM enrollments WHERE workspace_id = ? AND contact_id = ? AND status IN ('active','paused'))`,
      ).run(enrollmentId, ctx.workspaceId, campaign.id, version.id, member.contact_id, member.contact_point_id, now, now, ctx.workspaceId, member.contact_id);
      if (inserted.changes !== 1) continue;
      enrolled += 1;
      const sc = loadStepContext(db, enrollmentId);
      if (sc) materializeNext(env, sc, -1, now, actor, { ...(batch ? { batch } : {}), requestActionApproval: actionApprover(env, ctx.workspaceId, ctx.principalId) });
    }
    let batchApprovalId: string | null = null;
    if (batch && batch.ids.length) {
      const placeholders = batch.ids.map(() => '?').join(',');
      const actions = db.prepare(`SELECT id, content_hash, recipient_norm, payload FROM scheduled_actions WHERE id IN (${placeholders})`)
        .all<{ id: string; content_hash: string; recipient_norm: string | null; payload: string }>(...batch.ids);
      batchApprovalId = createBatchApproval(db, ctx.workspaceId, campaign.id, actions, ctx.principalId, now);
    }
    audit(db, ctx, now, 'campaign', campaign.id, 'activated', { versionId: version.id, enrolled, batchApprovalId });
    return { enrolled, batchApprovalId };
  });
}

export function actionApprover(env: DomainEnv, workspaceId: string, requestedBy: string): (actionId: string, contentHash: string) => string {
  return (actionId, contentHash) =>
    createApproval(env.db, { workspaceId, scope: 'action', subjectId: actionId, operationHash: contentHash, preview: { actionId }, requestedBy }, env.now());
}

export function setCampaignStatus(env: DomainEnv, ctx: AuthContext, campaignId: string, status: 'paused' | 'active' | 'completed', reason: string): void {
  requireRole(ctx, 'operator');
  env.db.transaction(() => {
    const now = env.now();
    const campaign = loadCampaign(env.db, ctx.workspaceId, campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${campaignId}`);
    const allowed = status === 'paused' ? ['active'] : status === 'active' ? ['paused'] : ['active', 'paused'];
    if (!allowed.includes(campaign.status)) throw new ConflictError(`cannot move campaign from ${campaign.status} to ${status}`);
    env.db.prepare('UPDATE campaigns SET status = ?, paused_reason = ?, updated_at = ? WHERE id = ?').run(status, status === 'paused' ? reason : null, now, campaignId);
    audit(env.db, ctx, now, 'campaign', campaignId, status, { reason });
  });
}

