import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import type { FakeSendMode } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { sweepExpiredLeases } from './recovery';
import { workerActor } from './actions-repo';
import { executeDue, runExecutionPass } from './executor';
import { SimulatedCrash, makeEnv, seedWorkspace } from './harness.test-util';

const modeArb: fc.Arbitrary<FakeSendMode> = fc.oneof(
  fc.constant<FakeSendMode>({ kind: 'accept' }),
  fc.constant<FakeSendMode>({ kind: 'reject', errorClass: 'transient' }),
  fc.constant<FakeSendMode>({ kind: 'reject', errorClass: 'rate_limited', retryAfterMs: 5_000 }),
  fc.constant<FakeSendMode>({ kind: 'reject', errorClass: 'invalid_recipient' }),
  fc.constant<FakeSendMode>({ kind: 'unknown_after_accept' }),
  fc.constant<FakeSendMode>({ kind: 'unknown_before_accept' }),
  fc.constant<FakeSendMode>({ kind: 'throw_after_accept' }),
);
const crashArb = fc.constantFrom<'none' | 'afterClaim' | 'afterPreflight' | 'beforeResult'>('none', 'none', 'afterClaim', 'afterPreflight', 'beforeResult');

describe('at-most-once invariant (ADR 0002)', () => {
  it('never delivers any action twice, whatever the provider does and wherever the worker dies', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.array(modeArb, { minLength: 1, maxLength: 30 }),
        fc.array(crashArb, { minLength: 1, maxLength: 12 }),
        async (actionCount, modes, crashes) => {
          const env = makeEnv();
          env.fake.script(...modes);
          const ids = Array.from({ length: actionCount }, (_, i) => env.enqueueEmail(`k${i}`, { maxAttempts: 4 }).id);
          for (let round = 0; round < 25; round += 1) {
            const crash = crashes[round % crashes.length] ?? 'none';
            const deps = crash === 'none' ? env.deps : env.with({ hooks: { [crash]: () => { throw new SimulatedCrash(crash); } } });
            try {
              await runExecutionPass(deps);
            } catch (error) {
              if (!(error instanceof SimulatedCrash)) throw error;
            }
            env.advance(11 * 60_000);
          }
          // Let the system settle without crashes.
          for (let round = 0; round < 10; round += 1) {
            await runExecutionPass(env.deps);
            env.advance(20 * 60_000);
          }
          for (const id of ids) {
            const action = env.action(id);
            const delivered = env.fake.deliveriesFor(action.rfc_message_id ?? '').length;
            expect(delivered).toBeLessThanOrEqual(1);
            expect(['succeeded', 'failed', 'review']).toContain(action.state);
            // With an authoritative reconciler, "succeeded" is exactly "delivered".
            expect(action.state === 'succeeded').toBe(delivered === 1);
          }
          expect(verifyAuditChain(env.db).ok).toBe(true);
          env.db.close();
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('concurrent workers on one database file', () => {
  it('two workers with separate connections never attempt the same action twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outreach-core-'));
    try {
      const path = join(dir, 'outreach.db');
      const first = makeEnv({ db: openSqliteDatabase(path) });
      const secondDb = openSqliteDatabase(path);
      const second = makeEnv({ db: secondDb, seed: false, fake: first.fake });
      const ids = Array.from({ length: 300 }, (_, i) => first.enqueueEmail(`k${i}`, { recipient: `r${i}@example.org` }).id);
      const workerTwo = second.with({ workerId: 'worker-2', now: first.now });
      await Promise.all([executeDue(first.deps), executeDue(workerTwo), executeDue(first.deps), executeDue(workerTwo)]);
      const perAction = first.db
        .prepare('SELECT action_id, COUNT(*) AS n FROM action_attempts GROUP BY action_id HAVING n > 1')
        .all();
      expect(perAction).toEqual([]);
      expect(ids.every((id) => first.action(id).state === 'succeeded')).toBe(true);
      expect(first.fake.deliveries).toHaveLength(300);
      expect(new Set(first.fake.deliveries.map((d) => d.rfcMessageId)).size).toBe(300);
      first.db.close();
      secondDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sweep never steals a live lease', async () => {
    const env = makeEnv();
    env.enqueueEmail('k1');
    const actor = workerActor('w', 't');
    await expect(
      executeDue(env.with({ hooks: { afterPreflight: () => { throw new SimulatedCrash('x'); } } })),
    ).rejects.toThrow(SimulatedCrash);
    expect(sweepExpiredLeases(env.deps, actor)).toEqual({ released: 0, madeUncertain: 0 });
    expect(seedWorkspace).toBeTypeOf('function');
  });
});
