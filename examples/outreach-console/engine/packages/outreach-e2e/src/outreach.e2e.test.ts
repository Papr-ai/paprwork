/**
 * BUILD_PLAN.md §13 "End to end": import -> compile -> activate -> approve first batch -> sends ->
 * inbound reply -> atomic stop -> notification -> audit verify, entirely on fake providers.
 */
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import {
  authenticate,
  bootstrapWorkspace,
  campaignStatus,
  commitActivation,
  configureNotifications,
  createCampaign,
  createEngine,
  createTemplate,
  decideApproval,
  handleUnsubscribe,
  ingestWebhook,
  listApprovals,
  listManualTasks,
  prepareActivation,
  recordManualOutcome,
  registerProviderAccount,
  addPrincipal,
} from '@splitin/outreach-core';
import { FAKE_EMAIL_SECRET, FakeEmailProvider, FakeNotifier, staticSecrets } from '@splitin/outreach-fakes';
import { commitImport, previewImport, saveMappingProfile } from '@splitin/outreach-import';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';

const DAY = 86_400_000;
const CSV = `Full name,Work email,Company,Role,Time zone,Segment
Ada Lovelace,ada@analytical.example.org,Analytical Engines,CTO,America/New_York,enterprise
Grace Hopper,grace@navy.example.net,US Navy,Admiral,America/New_York,public
Linus T,linus@kernel.example.com,Kernel Co,Maintainer,Europe/Helsinki,oss
Margaret H,margaret@apollo.example.org,Apollo,Lead,America/Chicago,enterprise
Duplicate Ada,ADA@analytical.example.org,,,,
Broken Row,not-an-email,,,,
`;

const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: e2e-intro }
spec:
  purpose: automated_outreach
  audience: { source: { importBatch: BATCH } }
  policy:
    approval: first_batch_then_campaign
    firstBatchSize: 2
    window: { timezone: recipient, fallback: America/New_York, days: [Mon, Tue, Wed, Thu, Fri], start: "08:00", end: "18:00" }
    limits: { accountPerDay: 100, domainPerDay: 10, recipientMinGap: P1D }
  steps:
    - { id: intro, type: email.send, template: intro@1 }
    - { id: wait, type: wait, duration: P2D }
    - { id: social, type: manual.task, channel: linkedin, template: note@1, when: no_reply }
    - { id: bump, type: email.reply, template: bump@1, when: no_reply }
`;

describe('outreach end to end', () => {
  it('runs the full loop with every stop path and a verifiable audit trail', async () => {
    // Monday 2025-06-02 09:00 in New York (16:00 in Helsinki): inside every recipient's window.
    let now = Date.parse('2025-06-02T13:00:00Z');
    const db = openSqliteDatabase(':memory:');
    const email = new FakeEmailProvider();
    const slack = new FakeNotifier('fake-slack');
    const engine = createEngine({
      db,
      adapters: [email.adapter(), slack.adapter()],
      secrets: staticSecrets({ 'env:MAIL': FAKE_EMAIL_SECRET, 'env:MAIL_HOOK': 'fake-webhook-secret-value', 'env:SLACK': FAKE_EMAIL_SECRET }),
      workerId: 'e2e-worker',
      sendGate: { mode: 'allowlist', allow: ['@analytical.example.org', '@navy.example.net', '@kernel.example.com', '@apollo.example.org'] },
      unsubscribe: { baseUrl: 'https://outreach.example.com/u/', secret: 'e2e-unsubscribe-fixture' },
      now: () => now,
      pollIntervalMs: 0,
      execution: { reconcileDelayMs: 0 },
    });
    const drain = async () => {
      for (let i = 0; i < 6; i += 1) await engine.runOnce();
    };

    // Workspace, people, accounts.
    bootstrapWorkspace(db, { workspaceId: 'splitin-demo', name: 'Demo', adminRef: 'cli:admin', adminName: 'Admin' }, now);
    const admin = authenticate(db, 'splitin-demo', 'cli:admin', 'cli', 'e2e');
    addPrincipal(engine, admin, { externalRef: 'slack:T1:U-op', displayName: 'Operator', roles: ['operator'] });
    addPrincipal(engine, admin, { externalRef: 'slack:T1:U-ap', displayName: 'Approver', roles: ['approver'] });
    const operator = authenticate(db, 'splitin-demo', 'slack:T1:U-op', 'slack', 'e2e');
    const approver = authenticate(db, 'splitin-demo', 'slack:T1:U-ap', 'slack', 'e2e');
    const mailAccount = await registerProviderAccount(engine, admin, {
      provider: 'fake-email', externalAccountId: 'hello@example.com', purposes: ['automated_outreach'], secretRef: 'env:MAIL', webhookSecretRef: 'env:MAIL_HOOK',
      sender: { name: 'Sam', address: 'hello@example.com', organization: 'Example Co', postalAddress: '1 Example Street, Springfield' },
    });
    const slackAccount = await registerProviderAccount(engine, admin, { provider: 'fake-slack', externalAccountId: '#gtm', purposes: ['transactional'], secretRef: 'env:SLACK', sender: { name: 'Outreach', address: 'bot@example.com' } });
    configureNotifications(engine, admin, slackAccount);

    // Import: preview, then commit exactly the preview.
    const actor = { workspaceId: 'splitin-demo', principalId: operator.principalId, source: 'slack', traceId: 'e2e' };
    const profile = db.transaction(() => saveMappingProfile(db, 'splitin-demo', 'crm-export', {
      columns: { full_name: 'Full name', email: 'Work email', org_name: 'Company', title: 'Role', timezone: 'Time zone' },
      attributes: { segment: 'Segment' },
      consent: { basis: 'legitimate_interest', evidence: 'business contact, B2B introduction' },
      jurisdiction: 'US',
    }, now));
    const preview = await previewImport(db, actor, { fileName: 'crm.csv', bytes: new TextEncoder().encode(CSV), profileId: profile.id, now });
    expect(preview.counts).toEqual({ create: 4, update: 0, merge: 1, reject: 1, ambiguous: 0 });
    commitImport(db, actor, { batchId: preview.batchId, previewHash: preview.previewHash, idempotencyKey: 'crm-2025-06-02', now });

    // Templates, campaign, activation with two-level approval.
    createTemplate(db, operator, { name: 'intro', channel: 'email', subject: '{{org_name}} and Example Co', text: 'Hi {{first_name}}, a quick idea for {{org_name}} ({{attr.segment}}).' }, now);
    createTemplate(db, operator, { name: 'note', channel: 'linkedin', text: 'Hi {{first_name}}, I emailed you about {{org_name}}.' }, now);
    createTemplate(db, operator, { name: 'bump', channel: 'email', text: 'Bumping this, {{first_name}}.' }, now);
    const { campaignId } = createCampaign(engine, operator, { name: 'June intro', playbook: PLAYBOOK.replace('BATCH', preview.batchId), providerAccountId: mailAccount });
    const activation = prepareActivation(engine, operator, campaignId);
    expect(activation.audienceCount).toBe(4);
    decideApproval(engine, approver, { approvalId: activation.approvalId ?? '', decision: 'approved', operationHash: activation.operationHash });
    const { enrolled, batchApprovalId } = commitActivation(engine, operator, { campaignId, operationHash: activation.operationHash });
    expect(enrolled).toBe(4);

    // Only the first two wait for the batch approval; the rest are covered by the campaign approval.
    await drain();
    expect(email.deliveries).toHaveLength(2);
    const batch = listApprovals(db, approver).find((row) => row.id === batchApprovalId);
    expect(JSON.parse(batch?.preview ?? '{}').actions).toHaveLength(2);
    decideApproval(engine, approver, { approvalId: batchApprovalId ?? '', decision: 'approved', operationHash: batch?.operation_hash ?? '' });
    now += 60_000;
    await drain();
    expect(email.deliveries).toHaveLength(4);
    expect(email.deliveries.every((d) => /^<https:\/\/outreach\.example\.com\/u\/[^>]+>, <mailto:/.test(d.headers['List-Unsubscribe'] ?? ''))).toBe(true);

    const to = (address: string) => {
      const delivery = email.deliveries.find((d) => d.to[0] === address);
      if (!delivery) throw new Error(`no delivery to ${address}`);
      return delivery;
    };
    // Ada replies by webhook; Grace clicks unsubscribe; Linus hard-bounces; Margaret stays silent.
    const reply = email.reply(to('ada@analytical.example.org'), { at: now });
    expect(await ingestWebhook(engine, { providerAccountId: mailAccount, ...email.signWebhook([reply], now) })).toMatchObject({ accepted: true, stored: 1 });
    const graceToken = /\/u\/([^>]+)>/.exec(to('grace@navy.example.net').headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    expect(handleUnsubscribe(engine, graceToken)).toEqual({ ok: true, alreadySuppressed: false });
    email.bounce(to('linus@kernel.example.com'), '5.1.1', now);
    await drain();

    // Two business days later only Margaret gets the social task; completing it releases the bump.
    now += 2 * DAY;
    await drain();
    const tasks = listManualTasks(engine, operator);
    expect(tasks.map((t) => t.draft_text)).toEqual(['Hi Margaret, I emailed you about Apollo.']);
    recordManualOutcome(engine, operator, tasks[0]?.id ?? '', 'done');
    await drain();
    const bumps = email.deliveries.filter((d) => d.subject.startsWith('Re:'));
    expect(bumps.map((d) => d.to[0])).toEqual(['margaret@apollo.example.org']);
    expect(bumps[0]?.providerThreadId).toBe(to('margaret@apollo.example.org').providerThreadId);

    const status = campaignStatus(engine, operator, campaignId);
    expect(status.enrollments).toEqual({ replied: 1, opted_out: 1, bounced: 1, completed: 1 });
    expect(slack.published.map((n) => n.title).sort()).toEqual(['Hard bounce: address suppressed', 'Reply received: sequence stopped']);
    const suppressed = db.prepare('SELECT value_norm, reason FROM suppressions ORDER BY value_norm').all();
    expect(suppressed).toEqual([
      { value_norm: 'grace@navy.example.net', reason: 'opt_out' },
      { value_norm: 'linus@kernel.example.com', reason: 'hard_bounce' },
    ]);
    // Every send happened exactly once, and the whole history verifies.
    expect(new Set(email.deliveries.map((d) => d.rfcMessageId)).size).toBe(email.deliveries.length);
    expect(verifyAuditChain(db)).toMatchObject({ ok: true });
  });
});
