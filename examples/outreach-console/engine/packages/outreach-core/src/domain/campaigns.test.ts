import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import { campaignStatus, listReview } from '../engine';
import { ConflictError, ForbiddenError } from './auth';
import { decideApproval, listApprovals, requestBatchApproval, revokeApproval } from './approvals';
import { commitActivation, createCampaign, prepareActivation, setCampaignStatus } from './campaigns';
import { PLAYBOOK, makeDomainEnv, type DomainTestEnv } from './domain.test-util';
import { listManualTasks, recordManualOutcome, setEnrollmentState, suppress } from './operations';

const DAY = 86_400_000;

async function activate(env: DomainTestEnv, playbook = PLAYBOOK) {
  const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Intro', playbook, providerAccountId: env.accountId });
  const preview = prepareActivation(env.engine, env.operator, campaignId);
  if (preview.approvalId) decideApproval(env.engine, env.approver, { approvalId: preview.approvalId, decision: 'approved', operationHash: preview.operationHash });
  const result = commitActivation(env.engine, env.operator, { campaignId, operationHash: preview.operationHash });
  return { campaignId, preview, ...result };
}

function approveBatch(env: DomainTestEnv, approvalId: string | null) {
  if (!approvalId) throw new Error('expected a batch approval');
  const approval = listApprovals(env.engine.db, env.approver).find((row) => row.id === approvalId);
  if (!approval) throw new Error('batch approval not pending');
  decideApproval(env.engine, env.approver, { approvalId, decision: 'approved', operationHash: approval.operation_hash });
}

function enrollmentStatuses(env: DomainTestEnv, campaignId: string) {
  return campaignStatus(env.engine, env.viewer, campaignId).enrollments;
}

describe('campaign lifecycle', () => {
  it('runs import-to-completion: approvals, window, threaded follow-up, manual task, completion', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    env.contact('grace@example.net', { fullName: 'Grace Hopper', firstName: 'Grace' });
    env.contact('noconsent@example.org', { consentBasis: 'unknown' });
    env.contact('blocked@example.org');
    suppress(env.engine, env.operator, { scope: 'global', value: 'blocked@example.org', reason: 'do_not_contact' });

    const { campaignId, preview, enrolled, batchApprovalId } = await activate(env);
    expect(preview.audienceCount).toBe(2);
    expect(preview.excluded).toMatchObject({ suppressed: 1, noConsent: 1 });
    expect(enrolled).toBe(2);

    // The first batch waits for its own approval.
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(0);
    approveBatch(env, batchApprovalId);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(2);
    const intro = env.fake.deliveries.find((d) => d.to[0] === 'ada@example.org');
    expect(intro?.subject).toBe('Quick question, Ada');
    expect(intro?.headers['List-Unsubscribe']).toMatch(/^<https:\/\/outreach\.example\.com\/u\/[^>]+>, <mailto:sender@example\.com\?subject=unsubscribe>$/);
    expect(intro?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Three business days later (Tue -> Fri), the threaded follow-up goes out.
    env.advance(2 * DAY);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(2);
    env.advance(DAY);
    await env.drain();
    const followups = env.fake.deliveries.filter((d) => d.subject === 'Re: Quick question, Ada');
    expect(followups).toHaveLength(1);
    expect(followups[0]?.providerThreadId).toBe(intro?.providerThreadId);

    // The social touch is a human task, then the closing email follows once it is done.
    const tasks = listManualTasks(env.engine, env.operator);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.draft_text).toMatch(/^Hi (Ada|Grace), sent you an email about Analytical Engines\.$/);
    for (const task of tasks) recordManualOutcome(env.engine, env.operator, task.id, 'done', 'sent from my own account');
    await env.drain();
    expect(env.fake.deliveries.filter((d) => d.subject.startsWith('Re:'))).toHaveLength(4);
    expect(enrollmentStatuses(env, campaignId)).toEqual({ completed: 2 });
    expect(verifyAuditChain(env.engine.db).ok).toBe(true);
  });

  it('sends only inside the recipient window', async () => {
    const saturday = DateTime.fromISO('2025-03-08T12:00', { zone: 'America/New_York' }).toMillis();
    const env = await makeDomainEnv({ start: saturday });
    env.contact('tokyo@example.org', { timezone: 'Asia/Tokyo' });
    approveBatch(env, (await activate(env)).batchApprovalId);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(0);
    env.setNow(DateTime.fromISO('2025-03-10T09:05', { zone: 'Asia/Tokyo' }).toMillis());
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
  });

  it('refuses stale previews and unapproved activation', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    const { campaignId } = createCampaign(env.engine, env.operator, { name: 'x', playbook: PLAYBOOK, providerAccountId: env.accountId });
    const first = prepareActivation(env.engine, env.operator, campaignId);
    expect(() => commitActivation(env.engine, env.operator, { campaignId, operationHash: first.operationHash })).toThrow(ForbiddenError);
    env.contact('late@example.org');
    const second = prepareActivation(env.engine, env.operator, campaignId);
    expect(second.operationHash).not.toBe(first.operationHash);
    expect(() => decideApproval(env.engine, env.approver, { approvalId: second.approvalId ?? '', decision: 'approved', operationHash: first.operationHash })).toThrow(ConflictError);
    expect(() => decideApproval(env.engine, env.operator, { approvalId: second.approvalId ?? '', decision: 'approved', operationHash: second.operationHash })).toThrow(ForbiddenError);
  });

  it('enforces separation of duties when the workspace asks for it', async () => {
    const env = await makeDomainEnv();
    env.engine.db.prepare(`UPDATE workspaces SET settings = '{"separationOfDuties":true}'`).run();
    env.contact('ada@example.org');
    const { campaignId } = createCampaign(env.engine, env.admin, { name: 'x', playbook: PLAYBOOK, providerAccountId: env.accountId });
    const preview = prepareActivation(env.engine, env.admin, campaignId);
    expect(() => decideApproval(env.engine, env.admin, { approvalId: preview.approvalId ?? '', decision: 'approved', operationHash: preview.operationHash })).toThrow(/separation of duties/);
    decideApproval(env.engine, env.approver, { approvalId: preview.approvalId ?? '', decision: 'approved', operationHash: preview.operationHash });
  });

  it('rejecting the first batch cancels it and stops those enrollments', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    const { campaignId, batchApprovalId } = await activate(env);
    const approval = listApprovals(env.engine.db, env.approver).find((row) => row.id === batchApprovalId);
    decideApproval(env.engine, env.approver, { approvalId: batchApprovalId ?? '', decision: 'rejected', operationHash: approval?.operation_hash ?? '', reason: 'copy too long' });
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(0);
    expect(enrollmentStatuses(env, campaignId)).toEqual({ stopped: 1 });
  });

  it('requires per-action approval under every_action', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    await activate(env, PLAYBOOK.replace('approval: first_batch_then_campaign', 'approval: every_action'));
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(0);
    const pending = listApprovals(env.engine.db, env.approver).filter((row) => row.scope === 'action');
    expect(pending).toHaveLength(1);
    decideApproval(env.engine, env.approver, { approvalId: pending[0]?.id ?? '', decision: 'approved', operationHash: pending[0]?.operation_hash ?? '' });
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
  });

  it('revoking the campaign approval holds later steps until a new batch is approved', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    const { campaignId, preview, batchApprovalId } = await activate(env);
    approveBatch(env, batchApprovalId);
    await env.drain();
    revokeApproval(env.engine, env.approver, preview.approvalId ?? '', 'legal review');
    env.advance(3 * DAY);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
    const request = requestBatchApproval(env.engine, env.operator, campaignId);
    expect(request?.count).toBe(1);
    decideApproval(env.engine, env.approver, { approvalId: request?.approvalId ?? '', decision: 'approved', operationHash: request?.operationHash ?? '' });
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(2);
  });
});

describe('stops and holds', () => {
  it('a suppression added mid-sequence cancels pending steps and stops the enrollment', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    const { campaignId, batchApprovalId } = await activate(env);
    approveBatch(env, batchApprovalId);
    await env.drain();
    suppress(env.engine, env.operator, { scope: 'domain', value: 'example.org', reason: 'do_not_contact' });
    env.advance(3 * DAY);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
    expect(enrollmentStatuses(env, campaignId)).toEqual({ stopped: 1 });
  });

  it('pausing a campaign or enrollment defers sends until resumed', async () => {
    const env = await makeDomainEnv();
    const contactId = env.contact('ada@example.org');
    const { campaignId, batchApprovalId } = await activate(env);
    approveBatch(env, batchApprovalId);
    setCampaignStatus(env.engine, env.operator, campaignId, 'paused', 'holiday');
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(0);
    setCampaignStatus(env.engine, env.operator, campaignId, 'active', 'back');
    env.advance(16 * 60_000);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
    const enrollment = env.engine.db.prepare('SELECT id FROM enrollments WHERE contact_id = ?').get<{ id: string }>(contactId);
    setEnrollmentState(env.engine, env.operator, enrollment?.id ?? '', 'pause', 'asked to wait');
    env.advance(3 * DAY);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
  });

  it('a hard bounce suppresses the address and marks the enrollment bounced', async () => {
    const env = await makeDomainEnv();
    env.contact('gone@example.org');
    env.fake.script({ kind: 'reject', errorClass: 'hard_bounce' });
    const { campaignId, batchApprovalId } = await activate(env);
    approveBatch(env, batchApprovalId);
    await env.drain();
    expect(enrollmentStatuses(env, campaignId)).toEqual({ bounced: 1 });
    const suppression = env.engine.db.prepare('SELECT scope, reason FROM suppressions WHERE value_norm = ?').get('gone@example.org');
    expect(suppression).toEqual({ scope: 'channel', reason: 'hard_bounce' });
  });

  it('a contact missing a required template value is stopped with a reason, never sent a broken email', async () => {
    const env = await makeDomainEnv();
    env.contact('nofirst@example.org', { firstName: '' });
    const { campaignId } = await activate(env);
    expect(enrollmentStatuses(env, campaignId)).toEqual({ error: 1 });
    const reason = env.engine.db.prepare('SELECT stop_reason FROM enrollments').get<{ stop_reason: string }>();
    expect(reason?.stop_reason).toBe('template_missing:first_name');
  });

  it('the default send gate parks real sends for review', async () => {
    const env = await makeDomainEnv({ sendGate: { mode: 'allowlist', allow: [] } });
    env.contact('ada@example.org');
    approveBatch(env, (await activate(env)).batchApprovalId);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(0);
    expect(listReview(env.engine, env.viewer).map((row) => row.state_reason)).toEqual(['not_in_live_allowlist']);
  });
});


it('activation confirmation exposes actual content and becomes stale when personalization changes', async () => {
  const env = await makeDomainEnv();
  const contactId = env.contact('ada@example.org');
  const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Preview', playbook: PLAYBOOK, providerAccountId: env.accountId });
  const preview = prepareActivation(env.engine, env.operator, campaignId);
  expect(preview.templates[0]?.body_text).toContain('{{first_name}}');
  expect(preview.sender.address).toBe('sender@example.com');
  expect(preview.policy.window.start).toBe('09:00');
  expect(preview.steps.some((step) => step.type === 'wait')).toBe(true);
  if (preview.approvalId) decideApproval(env.engine, env.approver, { approvalId: preview.approvalId, decision: 'approved', operationHash: preview.operationHash });
  env.engine.db.prepare('UPDATE contacts SET first_name = ? WHERE id = ?').run('Changed', contactId);
  expect(() => commitActivation(env.engine, env.operator, { campaignId, operationHash: preview.operationHash })).toThrow('content changed');
  expect(env.fake.deliveries).toHaveLength(0);
  expect(campaignStatus(env.engine, env.viewer, campaignId).status).toBe('draft');
  env.engine.db.close();
});
