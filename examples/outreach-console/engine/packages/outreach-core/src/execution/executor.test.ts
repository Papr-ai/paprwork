import { describe, expect, it, vi } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import { workerActor } from './actions-repo';
import { enqueueAction } from './enqueue';
import { executeDue, runExecutionPass } from './executor';
import { EMAIL_ACCOUNT, NOTIFY_ACCOUNT, WS, attempts, makeEnv } from './harness.test-util';
import { setKillSwitch } from './kill-switches';
import { resolveReviewAction } from './review';

describe('executor happy path', () => {
  it('sends once, records the attempt, the outbound message and a valid audit chain', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1');
    const report = await executeDue(env.deps);
    expect(report).toMatchObject({ claimed: 1, executed: 1 });
    expect(env.action(action.id)).toMatchObject({ state: 'succeeded', attempt_count: 1, lease_owner: null });
    expect(env.fake.deliveries).toHaveLength(1);
    expect(env.fake.deliveries[0]?.rfcMessageId).toBe(action.rfc_message_id);
    expect(attempts(env.db, action.id)).toEqual([{ outcome: 'succeeded', error_class: null }]);
    const message = env.db.prepare('SELECT * FROM messages WHERE action_id = ?').get<{ direction: string; recipient_norm: string }>(action.id);
    expect(message).toMatchObject({ direction: 'outbound', recipient_norm: 'lead@example.org' });
    expect(verifyAuditChain(env.db).ok).toBe(true);
  });

  it('does not touch actions that are not due', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1', { dueAt: env.now() + 60_000 });
    expect((await executeDue(env.deps)).claimed).toBe(0);
    env.advance(60_000);
    await executeDue(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
  });

  it('is idempotent on enqueue', () => {
    const env = makeEnv();
    const a = env.enqueueEmail('same');
    const b = env.enqueueEmail('same', { payload: { different: true } });
    expect(b.id).toBe(a.id);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM scheduled_actions').get<{ n: number }>()?.n).toBe(1);
  });
});

describe('rejections', () => {
  it('retries retryable errors with backoff and releases the budget', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'reject', errorClass: 'transient' });
    const action = env.enqueueEmail('k1');
    const deps = env.with({ ratePolicy: () => ({ limits: [{ scopeKey: 'account:day', windowMs: 86_400_000, limit: 10 }] }) });
    await executeDue(deps);
    const after = env.action(action.id);
    expect(after).toMatchObject({ state: 'scheduled', last_error_class: 'transient', attempt_count: 1 });
    expect(after.due_at).toBeGreaterThan(env.now());
    expect(env.db.prepare('SELECT used FROM rate_buckets').get<{ used: number }>()?.used).toBe(0);
    env.advance(after.due_at - env.now());
    await executeDue(deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
    expect(env.db.prepare('SELECT used FROM rate_buckets').get<{ used: number }>()?.used).toBe(1);
  });

  it('honours retryAfterMs from rate limits', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'reject', errorClass: 'rate_limited', retryAfterMs: 90_000 });
    const action = env.enqueueEmail('k1');
    await executeDue(env.deps);
    expect(env.action(action.id).due_at).toBe(env.now() + 90_000);
  });

  it('fails after max attempts', async () => {
    const env = makeEnv();
    env.fake.setDefault({ kind: 'reject', errorClass: 'transient' });
    const action = env.enqueueEmail('k1', { maxAttempts: 2 });
    for (let i = 0; i < 3; i += 1) {
      await executeDue(env.deps);
      env.advance(20 * 60_000);
    }
    expect(env.action(action.id)).toMatchObject({ state: 'failed', state_reason: 'max_attempts', attempt_count: 2 });
  });

  it('fails permanently on a bad recipient and reports domain effects', async () => {
    const env = makeEnv();
    const onErrorEffects = vi.fn();
    const onFailed = vi.fn();
    env.fake.script({ kind: 'reject', errorClass: 'invalid_recipient' });
    const action = env.enqueueEmail('k1');
    await executeDue(env.with({ effects: { onErrorEffects, onFailed } }));
    expect(env.action(action.id)).toMatchObject({ state: 'failed', state_reason: 'invalid_recipient' });
    expect(onErrorEffects).toHaveBeenCalledWith(env.db, expect.objectContaining({ id: action.id }), ['suppress_recipient', 'bounce_enrollment'], env.now());
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it('marks the account unhealthy on revoked auth and holds further sends', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'reject', errorClass: 'auth_revoked' });
    const first = env.enqueueEmail('k1');
    await executeDue(env.deps);
    expect(env.action(first.id).state).toBe('failed');
    const second = env.enqueueEmail('k2');
    await executeDue(env.deps);
    expect(env.action(second.id)).toMatchObject({ state: 'scheduled', state_reason: 'account_unhealthy' });
    expect(env.fake.sendCalls).toBe(1);
  });

  it('engages the account kill switch when the provider blocks for policy', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'reject', errorClass: 'policy_blocked' });
    env.enqueueEmail('k1');
    await executeDue(env.deps);
    const second = env.enqueueEmail('k2');
    await executeDue(env.deps);
    expect(env.action(second.id).state_reason).toBe('kill_switch:provider_account');
  });

  it('sends content rejections to review', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'reject', errorClass: 'content_rejected' });
    const action = env.enqueueEmail('k1');
    await executeDue(env.deps);
    expect(env.action(action.id).state).toBe('review');
  });
});

describe('gates', () => {
  it('defers while a kill switch is engaged and sends after release', async () => {
    const env = makeEnv();
    const actor = workerActor('admin', 'test');
    env.db.transaction(() => setKillSwitch(env.db, { workspaceId: WS, scope: 'global', targetId: '*', engaged: true, reason: 'incident' }, actor, env.now()));
    const action = env.enqueueEmail('k1');
    await executeDue(env.deps);
    expect(env.action(action.id)).toMatchObject({ state: 'scheduled', state_reason: 'kill_switch:global' });
    env.db.transaction(() => setKillSwitch(env.db, { workspaceId: WS, scope: 'global', targetId: '*', engaged: false, reason: 'resolved' }, actor, env.now()));
    env.advance(60_000);
    await executeDue(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
  });

  it('cancels expired actions', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1', { notAfter: env.now() - 1 });
    await executeDue(env.deps);
    expect(env.action(action.id)).toMatchObject({ state: 'cancelled', state_reason: 'expired' });
    expect(env.fake.sendCalls).toBe(0);
  });

  it('parks non-allowlisted recipients for review until the gate opens', async () => {
    const env = makeEnv();
    const gated = env.with({ sendGate: { mode: 'allowlist', allow: ['@example.com', 'vip@example.org'] } });
    const blocked = env.enqueueEmail('k1');
    const allowed = env.enqueueEmail('k2', { recipient: 'vip@example.org' });
    await executeDue(gated);
    expect(env.action(blocked.id)).toMatchObject({ state: 'review', state_reason: 'not_in_live_allowlist' });
    expect(env.action(allowed.id).state).toBe('succeeded');
    resolveReviewAction(env.deps, blocked.id, { kind: 'not_sent_retry' }, workerActor('admin', 'test'));
    await executeDue(env.deps);
    expect(env.action(blocked.id).state).toBe('succeeded');
  });

  it('sends purposes the account does not permit to review', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1', { purpose: 'marketing' });
    await executeDue(env.deps);
    expect(env.action(action.id)).toMatchObject({ state: 'review', state_reason: 'purpose_not_permitted:marketing' });
  });

  it('enforces fixed-window budgets and the per-recipient gap', async () => {
    const env = makeEnv();
    const day = 86_400_000;
    const deps = env.with({
      ratePolicy: () => ({ limits: [{ scopeKey: 'account:day', windowMs: day, limit: 2 }], recipientMinGapMs: 0 }),
    });
    const ids = ['a', 'b', 'c'].map((k) => env.enqueueEmail(k, { recipient: `${k}@example.org` }).id);
    await executeDue(deps);
    expect(ids.map((id) => env.action(id).state)).toEqual(['succeeded', 'succeeded', 'scheduled']);
    expect(env.action(ids[2] ?? '').due_at).toBe(Math.floor(env.now() / day) * day + day);

    const gapDeps = env.with({ ratePolicy: () => ({ limits: [], recipientMinGapMs: 3 * day }) });
    const repeat = env.enqueueEmail('again', { recipient: 'a@example.org' });
    await executeDue(gapDeps);
    expect(env.action(repeat.id)).toMatchObject({ state: 'scheduled', state_reason: 'recipient_min_gap' });
  });
});

describe('other kinds', () => {
  it('never retries an uncertain notification', async () => {
    const env = makeEnv();
    env.notifier.script({ kind: 'unknown_after_accept' });
    const note = env.db.transaction(() =>
      enqueueAction(env.db, { workspaceId: WS, kind: 'notify.publish', providerAccountId: NOTIFY_ACCOUNT, idempotencyKey: 'n1', dueAt: env.now(), payload: { title: 'Reply', lines: ['x'], severity: 'info' } }, workerActor('t', 't'), env.now()),
    ).action;
    await runExecutionPass(env.deps);
    await runExecutionPass(env.deps);
    expect(env.action(note.id)).toMatchObject({ state: 'failed', state_reason: 'uncertain_not_reconcilable' });
    expect(env.notifier.published).toHaveLength(1);
  });

  it('turns manual steps into open tasks without any provider call', async () => {
    const env = makeEnv();
    const task = env.db.transaction(() =>
      enqueueAction(env.db, { workspaceId: WS, kind: 'manual.task', idempotencyKey: 'm1', dueAt: env.now(), payload: { channel: 'linkedin', targetUrl: 'https://www.linkedin.com/in/example', draft: 'Hi' } }, workerActor('t', 't'), env.now()),
    ).action;
    await executeDue(env.deps);
    expect(env.action(task.id).state).toBe('succeeded');
    expect(env.db.prepare('SELECT status, channel FROM manual_tasks WHERE action_id = ?').get(task.id)).toEqual({ status: 'open', channel: 'linkedin' });
    expect(env.fake.sendCalls).toBe(0);
    expect(EMAIL_ACCOUNT).toBeTruthy();
  });
});
