import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import { FAKE_WEBHOOK_SECRET, type FakeDelivery } from '@splitin/outreach-fakes';
import { decideApproval, listApprovals } from '../domain/approvals';
import { commitActivation, createCampaign, prepareActivation } from '../domain/campaigns';
import { PLAYBOOK, makeDomainEnv, type DomainTestEnv } from '../domain/domain.test-util';
import { configureNotifications, registerProviderAccount } from '../domain/operations';
import { campaignStatus } from '../engine';
import { claimActions, preflight } from '../execution/preflight';
import { workerActor } from '../execution/actions-repo';
import { ingestWebhook } from './ingest';
import { processInboundEvents } from './process';
import { handleUnsubscribe } from './unsubscribe';

const DAY = 86_400_000;

async function started(options: { notify?: boolean; contacts?: string[] } = {}) {
  const env = await makeDomainEnv();
  for (const email of options.contacts ?? ['ada@example.org']) env.contact(email);
  if (options.notify) {
    const notifyId = await registerProviderAccount(env.engine, env.admin, { provider: 'fake-notify', externalAccountId: '#gtm', sender: { name: 'Ops', address: 'ops@example.com' }, purposes: ['transactional'], secretRef: 'env:FAKE_EMAIL' });
    configureNotifications(env.engine, env.admin, notifyId);
  }
  const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Intro', playbook: PLAYBOOK, providerAccountId: env.accountId });
  const preview = prepareActivation(env.engine, env.operator, campaignId);
  decideApproval(env.engine, env.approver, { approvalId: preview.approvalId ?? '', decision: 'approved', operationHash: preview.operationHash });
  const { batchApprovalId } = commitActivation(env.engine, env.operator, { campaignId, operationHash: preview.operationHash });
  const batch = listApprovals(env.engine.db, env.approver).find((row) => row.id === batchApprovalId);
  decideApproval(env.engine, env.approver, { approvalId: batch?.id ?? '', decision: 'approved', operationHash: batch?.operation_hash ?? '' });
  await env.drain();
  return { env, campaignId, first: env.fake.deliveries[0] as FakeDelivery };
}

const statuses = (env: DomainTestEnv, campaignId: string) => campaignStatus(env.engine, env.viewer, campaignId).enrollments;
const events = (env: DomainTestEnv) => env.engine.db.prepare('SELECT status, class, correlation FROM provider_events ORDER BY received_at, id').all();

describe('replies stop sequences', () => {
  it('a threaded reply by webhook stops the enrollment before the follow-up, and notifies', async () => {
    const { env, campaignId, first } = await started({ notify: true });
    const reply = env.fake.reply(first, { at: env.now() + 60_000 });
    const signed = env.fake.signWebhook([reply], env.now());
    expect(await ingestWebhook(env.engine, { providerAccountId: env.accountId, ...signed })).toEqual({ accepted: true, stored: 1, duplicates: 0 });
    env.advance(3 * DAY);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
    expect(statuses(env, campaignId)).toEqual({ replied: 1 });
    expect(events(env)).toEqual([{ status: 'processed', class: 'human_reply', correlation: 'strong:thread' }]);
    expect(env.notifier.published.map((n) => n.title)).toEqual(['Reply received: sequence stopped']);
    expect(env.notifier.published[0]?.lines.join(' ')).not.toMatch(/happy to talk/);
    const inbound = env.engine.db.prepare(`SELECT direction, enrollment_id FROM messages WHERE direction = 'inbound'`).get<{ enrollment_id: string | null }>();
    expect(inbound?.enrollment_id).toBeTruthy();
    expect(verifyAuditChain(env.engine.db).ok).toBe(true);
  });

  it('the same event from webhook and polling is processed once', async () => {
    const { env, campaignId, first } = await started();
    const reply = env.fake.reply(first, { at: env.now() });
    await ingestWebhook(env.engine, { providerAccountId: env.accountId, ...env.fake.signWebhook([reply], env.now()) });
    await env.drain();
    expect(env.engine.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get<{ n: number }>()?.n).toBe(1);
    expect(statuses(env, campaignId)).toEqual({ replied: 1 });
  });

  it('correlates by Message-ID when the provider gives no thread id, and weakly by address', async () => {
    const { env, campaignId, first } = await started({ contacts: ['ada@example.org', 'grace@example.net'] });
    const grace = env.fake.deliveries.find((d) => d.to[0] === 'grace@example.net') as FakeDelivery;
    const ada = env.fake.deliveries.find((d) => d.to[0] === 'ada@example.org') as FakeDelivery;
    env.fake.pushInbound({ kind: 'message', inReplyTo: ada.rfcMessageId, references: [ada.rfcMessageId], from: 'ada@example.org', to: [ada.from], headers: {}, snippet: 'Yes', at: env.now() });
    env.fake.pushInbound({ kind: 'message', references: [], from: 'Grace@Example.net', to: [grace.from], subject: 'New thread', headers: {}, snippet: 'Hi', at: env.now() });
    await env.drain();
    expect(statuses(env, campaignId)).toEqual({ replied: 2 });
    expect(events(env)).toEqual([
      { status: 'processed', class: 'human_reply', correlation: 'strong:message_id' },
      { status: 'review', class: 'human_reply', correlation: 'weak:recipient' },
    ]);
    expect(first).toBeTruthy();
  });

  it('a reply arriving while the follow-up is claimed cancels it; the worker then loses the action', async () => {
    const { env, first } = await started();
    env.advance(3 * DAY);
    const actor = workerActor(env.engine.exec.workerId, 't');
    const [claimed] = claimActions(env.engine.exec, actor, 1);
    expect(claimed).toBeTruthy();
    env.fake.reply(first, { at: env.now() });
    await env.engine.runOnce();
    expect(preflight(env.engine.exec, claimed ?? '', actor)).toEqual({ kind: 'lost' });
    expect(env.fake.deliveries).toHaveLength(1);
  });
});

describe('other inbound classes', () => {
  it('out-of-office replies do not stop the sequence', async () => {
    const { env, campaignId, first } = await started();
    env.fake.reply(first, { subject: 'Automatic reply: Quick question', headers: { 'Auto-Submitted': 'auto-replied' }, at: env.now() });
    env.advance(3 * DAY);
    await env.drain();
    expect(statuses(env, campaignId)).toEqual({ active: 1 });
    expect(env.fake.deliveries).toHaveLength(2);
  });

  it('an opt-out reply suppresses globally and stops every live enrollment', async () => {
    const { env, campaignId, first } = await started({ notify: true });
    env.fake.reply(first, { snippet: 'Please remove me from your list', at: env.now() });
    await env.drain();
    expect(statuses(env, campaignId)).toEqual({ opted_out: 1 });
    expect(env.engine.db.prepare(`SELECT scope, reason FROM suppressions WHERE value_norm = 'ada@example.org'`).get()).toEqual({ scope: 'global', reason: 'opt_out' });
    expect(env.notifier.published.map((n) => n.title)).toEqual(['Opt-out: contact suppressed']);
  });

  it('hard bounces stop at once; soft bounces only after three', async () => {
    const { env, campaignId, first } = await started({ contacts: ['ada@example.org', 'grace@example.net'] });
    const grace = env.fake.deliveries.find((d) => d.to[0] === 'grace@example.net') as FakeDelivery;
    const ada = env.fake.deliveries.find((d) => d.to[0] === 'ada@example.org') as FakeDelivery;
    env.fake.bounce(ada, '5.1.1', env.now());
    env.fake.bounce(grace, '4.2.2', env.now());
    await env.drain();
    expect(statuses(env, campaignId)).toEqual({ bounced: 1, active: 1 });
    env.fake.bounce(grace, '4.2.2', env.now());
    env.fake.bounce(grace, '4.2.2', env.now());
    await env.drain();
    expect(statuses(env, campaignId)).toEqual({ bounced: 2 });
    expect(first).toBeTruthy();
  });

  it('a complaint suppresses the recipient and engages the account kill switch', async () => {
    const { env, first } = await started({ contacts: ['ada@example.org', 'grace@example.net'] });
    env.fake.complaint(first, env.now());
    env.advance(3 * DAY);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(2);
    const pending = env.engine.db.prepare(`SELECT state_reason FROM scheduled_actions WHERE state = 'scheduled'`).all();
    expect(pending).toEqual([{ state_reason: 'kill_switch:provider_account' }]);
  });

  it('uncorrelated mail goes to review; delivery receipts are ignored', async () => {
    const { env } = await started();
    env.fake.pushInbound({ kind: 'message', references: [], from: 'stranger@example.com', to: ['sender@example.com'], headers: {}, at: env.now() });
    env.fake.pushInbound({ kind: 'delivery', references: [], from: 'mailer@example.net', to: [], headers: {}, at: env.now() });
    const report = processInboundEvents(env.engine);
    expect(report.processed).toBe(0);
    await env.engine.runOnce();
    expect(events(env).map((e) => (e as { status: string }).status)).toEqual(['review', 'ignored']);
  });
});

describe('webhook ingress and unsubscribe', () => {
  it('rejects forged, stale and oversized webhooks and stores nothing', async () => {
    const { env, first } = await started();
    const reply = env.fake.reply(first, { at: env.now() });
    const good = env.fake.signWebhook([reply], env.now());
    const forged = { rawBody: good.rawBody, headers: { ...good.headers, 'x-fake-signature': '00'.repeat(32) } };
    const stale = env.fake.signWebhook([reply], env.now() - 10 * 60_000);
    expect(await ingestWebhook(env.engine, { providerAccountId: env.accountId, ...forged })).toEqual({ accepted: false, reason: 'verification_failed' });
    expect(await ingestWebhook(env.engine, { providerAccountId: env.accountId, ...stale })).toEqual({ accepted: false, reason: 'verification_failed' });
    expect(await ingestWebhook(env.engine, { providerAccountId: env.accountId, rawBody: new Uint8Array(1_000_001), headers: {} })).toEqual({ accepted: false, reason: 'too_large' });
    expect(env.engine.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get<{ n: number }>()?.n).toBe(0);
    expect(FAKE_WEBHOOK_SECRET).toBeTruthy();
  });

  it('the List-Unsubscribe link suppresses immediately, stops the sequence and is idempotent', async () => {
    const { env, campaignId, first } = await started();
    const url = /^<(https:[^>]+)>/.exec(first.headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    const token = url.split('/u/')[1] ?? '';
    expect(handleUnsubscribe(env.engine, token)).toEqual({ ok: true, alreadySuppressed: false });
    expect(handleUnsubscribe(env.engine, token)).toEqual({ ok: true, alreadySuppressed: true });
    expect(handleUnsubscribe(env.engine, `${token.split('.')[0]}.${'0'.repeat(64)}`)).toEqual({ ok: false, reason: 'invalid_token' });
    env.advance(3 * DAY);
    await env.drain();
    expect(statuses(env, campaignId)).toEqual({ opted_out: 1 });
    expect(env.fake.deliveries).toHaveLength(1);
  });
});
