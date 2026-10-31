import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import { workerActor } from './actions-repo';
import { executeDue, runExecutionPass } from './executor';
import { SimulatedCrash, attempts, makeEnv } from './harness.test-util';
import { claimActions, preflight } from './preflight';
import { reconcileUncertain, sweepExpiredLeases } from './recovery';
import { recordResult } from './results';
import { resolveReviewAction } from './review';

const LEASE = 10 * 60_000 + 1;

describe('uncertain provider outcomes', () => {
  it('reconciles a timeout-after-accept to succeeded without resending', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'unknown_after_accept' });
    const action = env.enqueueEmail('k1');
    await executeDue(env.deps);
    expect(env.action(action.id)).toMatchObject({ state: 'uncertain', state_reason: 'provider_outcome_unknown' });
    await runExecutionPass(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
    expect(env.fake.sendCalls).toBe(1);
    expect(attempts(env.db, action.id).map((a) => a.outcome)).toEqual(['succeeded']);
  });

  it('retries only after the provider affirms the message is absent', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'unknown_before_accept' });
    const action = env.enqueueEmail('k1');
    await executeDue(env.deps);
    await runExecutionPass(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
    expect(attempts(env.db, action.id).map((a) => a.outcome)).toEqual(['confirmed_absent', 'succeeded']);
  });

  it('treats an adapter crash after accept as unknown and reconciles it', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'throw_after_accept' });
    const action = env.enqueueEmail('k1');
    await runExecutionPass(env.deps);
    await runExecutionPass(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
  });

  it('sends undecidable actions to review and never resends them', async () => {
    const env = makeEnv();
    env.fake.reconcileMode = 'still_unknown';
    env.fake.script({ kind: 'unknown_before_accept' });
    const action = env.enqueueEmail('k1');
    for (let i = 0; i < 6; i += 1) {
      await runExecutionPass(env.deps);
      env.advance(10 * 60_000);
    }
    expect(env.action(action.id)).toMatchObject({ state: 'review', reconcile_count: 3 });
    expect(env.fake.sendCalls).toBe(1);
    resolveReviewAction(env.deps, action.id, { kind: 'drop', reason: 'operator_checked' }, workerActor('admin', 't'));
    expect(env.action(action.id).state).toBe('cancelled');
  });
});

describe('crash recovery at every step boundary', () => {
  const crashAt = (point: 'afterClaim' | 'afterPreflight' | 'beforeResult') => ({
    [point]: () => {
      throw new SimulatedCrash(point);
    },
  });

  it('after claim: the lease expires and the action is simply scheduled again', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1');
    await expect(executeDue(env.with({ hooks: crashAt('afterClaim') }))).rejects.toThrow(SimulatedCrash);
    expect(env.action(action.id).state).toBe('claimed');
    env.advance(LEASE);
    expect(sweepExpiredLeases(env.deps, workerActor('w', 't'))).toEqual({ released: 1, madeUncertain: 0 });
    await executeDue(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
  });

  it('after preflight commit: never blindly resent; reconciled as absent, then sent once', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1');
    await expect(executeDue(env.with({ hooks: crashAt('afterPreflight') }))).rejects.toThrow(SimulatedCrash);
    expect(env.action(action.id).state).toBe('executing');
    env.advance(LEASE);
    expect(sweepExpiredLeases(env.deps, workerActor('w', 't'))).toEqual({ released: 0, madeUncertain: 1 });
    await runExecutionPass(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
  });

  it('after the provider accepted but before the result was stored: reconciled as found, no resend', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1');
    await expect(executeDue(env.with({ hooks: crashAt('beforeResult') }))).rejects.toThrow(SimulatedCrash);
    expect(env.fake.deliveries).toHaveLength(1);
    env.advance(LEASE);
    await runExecutionPass(env.deps);
    expect(env.action(action.id).state).toBe('succeeded');
    expect(env.fake.deliveries).toHaveLength(1);
    expect(env.fake.sendCalls).toBe(1);
    expect(verifyAuditChain(env.db).ok).toBe(true);
  });

  it('a late definitive result resolves an action the sweeper already parked as uncertain', async () => {
    const env = makeEnv();
    const action = env.enqueueEmail('k1');
    const actor = workerActor(env.deps.workerId, 't');
    claimActions(env.deps, actor, 1);
    const go = preflight(env.deps, action.id, actor);
    if (go.kind !== 'go') throw new Error('expected go');
    env.advance(LEASE);
    sweepExpiredLeases(env.deps, actor);
    expect(env.action(action.id).state).toBe('uncertain');
    recordResult(env.deps, action.id, go.attemptId, { kind: 'accepted', receipt: { providerMessageId: 'late-1', acceptedAt: env.now() } }, actor);
    expect(env.action(action.id).state).toBe('succeeded');
  });

  it('a reconciler that dies mid-flight hands the action back as uncertain', async () => {
    const env = makeEnv();
    env.fake.script({ kind: 'unknown_before_accept' });
    const action = env.enqueueEmail('k1');
    await executeDue(env.deps);
    const actor = workerActor(env.deps.workerId, 't');
    env.db.transaction(() =>
      env.db.prepare(`UPDATE scheduled_actions SET state = 'reconciling', lease_owner = 'dead', lease_expires_at = ? WHERE id = ?`).run(env.now() - 1, action.id),
    );
    sweepExpiredLeases(env.deps, actor);
    expect(env.action(action.id).state).toBe('uncertain');
    await reconcileUncertain(env.deps, actor);
    expect(env.action(action.id).state).toBe('scheduled');
  });
});
