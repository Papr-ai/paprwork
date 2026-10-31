import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import { campaignStatus } from '../engine';
import { readSendGate, setSendGate } from './access';
import { ForbiddenError } from './auth';
import { decideApproval, listApprovals } from './approvals';
import { commitActivation, createCampaign, prepareActivation } from './campaigns';
import { makeDomainEnv, PLAYBOOK, type DomainTestEnv } from './domain.test-util';
import { jurisdictionVerdict, readJurisdictionPolicy, setJurisdictionPolicy, type JurisdictionPolicy, type JurisdictionPolicyInput } from './jurisdictions';

const STRICT: JurisdictionPolicyInput = { rules: { US: 'allow', GB: 'allow', DE: 'consent_required', CA: 'consent_required' }, default: 'block', unknown: 'allow' };
const SIGNOFF = { by: 'Counsel', reference: 'LEGAL-12 outreach memo' };

function policy(input: JurisdictionPolicyInput): JurisdictionPolicy {
  return { ...input, signoff: { ...SIGNOFF, at: 0, recordedBy: 'p' } };
}

function prepare(env: DomainTestEnv) {
  const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Intro', playbook: PLAYBOOK, providerAccountId: env.accountId });
  return { campaignId, preview: prepareActivation(env.engine, env.operator, campaignId) };
}

describe('jurisdictionVerdict', () => {
  const strict = policy(STRICT);
  it.each([
    ['US', 'legitimate_interest', true],
    ['us', 'unknown', true],
    ['DE', 'legitimate_interest', false],
    ['DE', 'consent', true],
    ['CA', 'existing_relationship', true],
    ['FR', 'consent', false],
    [null, 'legitimate_interest', true],
    ['unknown', 'legitimate_interest', true],
  ] as const)('%s with %s -> %s', (country, basis, ok) => {
    expect(jurisdictionVerdict(strict, country, basis).ok).toBe(ok);
  });

  it('names the rule that refused', () => {
    expect(jurisdictionVerdict(strict, 'FR', 'consent')).toEqual({ ok: false, reason: 'jurisdiction_blocked:FR' });
    expect(jurisdictionVerdict(strict, 'DE', null)).toEqual({ ok: false, reason: 'jurisdiction_needs_consent:DE' });
    expect(jurisdictionVerdict(policy({ ...STRICT, unknown: 'block' }), null, 'consent')).toEqual({ ok: false, reason: 'jurisdiction_blocked:unknown' });
  });

  it('permits everything while no policy is recorded (the live-send gate is the limit then)', () => {
    expect(jurisdictionVerdict(null, 'DE', null).ok).toBe(true);
  });
});

describe('jurisdiction policy', () => {
  it('is admin-only, needs a sign-off, validates country codes and is audited', async () => {
    const env = await makeDomainEnv();
    expect(() => setJurisdictionPolicy(env.engine, env.operator, STRICT, SIGNOFF)).toThrow(ForbiddenError);
    expect(() => setJurisdictionPolicy(env.engine, env.admin, STRICT, { by: 'x', reference: '' })).toThrow(/sign-off/);
    expect(() => setJurisdictionPolicy(env.engine, env.admin, { ...STRICT, rules: { Germany: 'block' } }, SIGNOFF)).toThrow(ZodError);
    expect(readJurisdictionPolicy(env.engine.db, 'ws')).toBeNull();

    const saved = setJurisdictionPolicy(env.engine, env.admin, STRICT, SIGNOFF);
    expect(readJurisdictionPolicy(env.engine.db, 'ws')).toEqual(saved);
    expect(saved.signoff).toMatchObject({ by: 'Counsel', reference: 'LEGAL-12 outreach memo', recordedBy: env.admin.principalId });
    const audited = env.engine.db.prepare(`SELECT detail FROM audit_events WHERE action = 'jurisdiction_policy_changed'`).all<{ detail: string }>();
    expect(audited).toHaveLength(1);
    expect(verifyAuditChain(env.engine.db).ok).toBe(true);
  });

  it('must exist before the live-send gate opens; allowlist testing does not need it', async () => {
    const env = await makeDomainEnv();
    setSendGate(env.engine, env.admin, { mode: 'allowlist', allow: ['@example.org'] }, 'pilot with our own addresses');
    expect(() => setSendGate(env.engine, env.admin, { mode: 'open' }, 'D1 decided, going live')).toThrow(/jurisdiction policy/);
    setJurisdictionPolicy(env.engine, env.admin, STRICT, SIGNOFF);
    setSendGate(env.engine, env.admin, { mode: 'open' }, 'D1 decided, going live');
    expect(readSendGate(env.engine.db, 'ws')).toEqual({ mode: 'open' });
  });

  it('rejects an invalid jurisdiction on a new contact instead of storing it as unknown', async () => {
    const env = await makeDomainEnv();
    expect(() => env.contact('hans@example.de', { jurisdiction: 'Germany' })).toThrow(ZodError);
    env.contact('hans@example.de', { jurisdiction: 'de' });
    const row = env.engine.db.prepare(`SELECT jurisdiction FROM contact_points WHERE value_norm = 'hans@example.de'`).get<{ jurisdiction: string }>();
    expect(row?.jurisdiction).toBe('DE');
  });
});

describe('enforcement', () => {
  it('excludes recipients the policy does not permit when the audience is snapshotted', async () => {
    const env = await makeDomainEnv();
    setJurisdictionPolicy(env.engine, env.admin, STRICT, SIGNOFF);
    env.contact('ada@example.com', { jurisdiction: 'US' });
    env.contact('hans@example.de', { jurisdiction: 'DE' });
    env.contact('greta@example.de', { jurisdiction: 'DE', consentBasis: 'consent' });
    env.contact('marie@example.fr', { jurisdiction: 'FR' });
    env.contact('someone@example.org');
    const { preview } = prepare(env);
    expect(preview.audienceCount).toBe(3);
    expect(preview.excluded).toMatchObject({ jurisdiction: 2, noConsent: 0 });
  });

  it('re-checks at send time: a policy tightened after activation cancels the send and stops the enrollment', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.com', { jurisdiction: 'US' });
    env.contact('hans@example.de', { jurisdiction: 'DE' });
    const { campaignId, preview } = prepare(env);
    expect(preview.audienceCount).toBe(2);
    if (preview.approvalId) decideApproval(env.engine, env.approver, { approvalId: preview.approvalId, decision: 'approved', operationHash: preview.operationHash });
    const { batchApprovalId } = commitActivation(env.engine, env.operator, { campaignId, operationHash: preview.operationHash });

    setJurisdictionPolicy(env.engine, env.admin, STRICT, SIGNOFF);
    const batch = listApprovals(env.engine.db, env.approver).find((row) => row.id === batchApprovalId);
    if (!batch) throw new Error('expected a pending batch approval');
    decideApproval(env.engine, env.approver, { approvalId: batch.id, decision: 'approved', operationHash: batch.operation_hash });
    await env.drain();

    expect(env.fake.deliveries.map((d) => d.to[0])).toEqual(['ada@example.com']);
    expect(campaignStatus(env.engine, env.viewer, campaignId).enrollments).toEqual({ active: 1, stopped: 1 });
    const cancelled = env.engine.db
      .prepare(`SELECT state, state_reason FROM scheduled_actions WHERE recipient_norm = 'hans@example.de'`)
      .get<{ state: string; state_reason: string }>();
    expect(cancelled).toEqual({ state: 'cancelled', state_reason: 'jurisdiction_needs_consent:DE' });
  });
});
