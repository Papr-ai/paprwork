/**
 * Email adapter conformance kit (BUILD_PLAN.md §5.5). Framework-agnostic: each case throws on failure,
 * so any test runner can execute it. Cases that need a forced outcome are skipped when the harness
 * cannot force one (for example a real sandbox account).
 */
import {
  ERROR_CLASSES,
  ulid,
  type ApprovedEmail,
  type EmailSender,
  type ProviderContext,
  type SecretResolver,
} from '@splitin/outreach-contracts';
import type { FakeSendMode } from './fake-email';

export interface EmailConformanceHarness {
  readonly sender: EmailSender;
  readonly ctx: ProviderContext;
  /** The secret value behind `ctx.secretRef`; it must never appear in results. */
  readonly secretValue: string;
  /** Recipient the harness may send to (a sandbox or allowlisted address). */
  readonly recipient: string;
  /** Forces the next send outcome. Absent for real providers. */
  readonly force?: (mode: FakeSendMode) => void;
}

export interface ConformanceCase {
  readonly name: string;
  readonly needsForce: boolean;
  run(harness: EmailConformanceHarness): Promise<void>;
}

export class ConformanceFailure extends Error {
  constructor(caseName: string, message: string) {
    super(`[${caseName}] ${message}`);
    this.name = 'ConformanceFailure';
  }
}

function makeEmail(harness: EmailConformanceHarness): ApprovedEmail {
  const id = ulid();
  return {
    actionId: `conf-${id}`,
    idempotencyKey: `conf:${id}`,
    rfcMessageId: `<${id}.conformance@example.com>`,
    contentHash: 'conformance',
    from: { address: harness.ctx.account.sender.address, name: harness.ctx.account.sender.name },
    to: [{ address: harness.recipient }],
    subject: `Conformance ${id}`,
    text: 'Conformance test message.',
    headers: {},
  };
}

function uncertainFrom(email: ApprovedEmail, at: number) {
  return {
    actionId: email.actionId,
    idempotencyKey: email.idempotencyKey,
    rfcMessageId: email.rfcMessageId,
    to: email.to.map((to) => to.address),
    attemptedAt: at,
  };
}

function assert(condition: unknown, caseName: string, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(caseName, message);
}

function assertNoSecret(value: unknown, harness: EmailConformanceHarness, caseName: string): void {
  const serialized = JSON.stringify(value) ?? '';
  assert(!serialized.includes(harness.secretValue), caseName, 'result leaks the credential');
}

export const EMAIL_SENDER_CONFORMANCE: readonly ConformanceCase[] = [
  {
    name: 'accepted send returns stable provider ids and no secrets',
    needsForce: false,
    async run(h) {
      const result = await h.sender.send(h.ctx, makeEmail(h));
      assert(result.kind === 'accepted', this.name, `expected accepted, got ${result.kind}`);
      assert(result.receipt.providerMessageId.length > 0, this.name, 'empty providerMessageId');
      assert(Number.isFinite(result.receipt.acceptedAt), this.name, 'acceptedAt is not a timestamp');
      assertNoSecret(result, h, this.name);
    },
  },
  {
    name: 'reconcile finds an accepted send with the same provider message id',
    needsForce: false,
    async run(h) {
      const email = makeEmail(h);
      const sent = await h.sender.send(h.ctx, email);
      assert(sent.kind === 'accepted', this.name, `expected accepted, got ${sent.kind}`);
      const found = await h.sender.reconcile(h.ctx, uncertainFrom(email, h.ctx.now()));
      assert(found.kind !== 'absent', this.name, 'reconcile claimed an accepted message is absent');
      if (found.kind === 'found') {
        assert(
          found.receipt.providerMessageId === sent.receipt.providerMessageId,
          this.name,
          'reconcile returned a different providerMessageId',
        );
      }
    },
  },
  {
    name: 'reconcile never finds a message that was never sent',
    needsForce: false,
    async run(h) {
      const result = await h.sender.reconcile(h.ctx, uncertainFrom(makeEmail(h), h.ctx.now()));
      assert(result.kind !== 'found', this.name, 'reconcile found a message that was never sent');
    },
  },
  {
    name: 'a timeout after accept reports unknown and reconciles to found',
    needsForce: true,
    async run(h) {
      h.force?.({ kind: 'unknown_after_accept' });
      const email = makeEmail(h);
      const result = await h.sender.send(h.ctx, email);
      assert(result.kind === 'unknown', this.name, `expected unknown, got ${result.kind}`);
      const found = await h.sender.reconcile(h.ctx, uncertainFrom(email, h.ctx.now()));
      assert(found.kind !== 'absent', this.name, 'reconcile reported absent for a delivered message');
    },
  },
  {
    name: 'a timeout before accept never reconciles to found',
    needsForce: true,
    async run(h) {
      h.force?.({ kind: 'unknown_before_accept' });
      const email = makeEmail(h);
      const result = await h.sender.send(h.ctx, email);
      assert(result.kind === 'unknown', this.name, `expected unknown, got ${result.kind}`);
      const reconciled = await h.sender.reconcile(h.ctx, uncertainFrom(email, h.ctx.now()));
      assert(reconciled.kind !== 'found', this.name, 'reconcile found a message that was never delivered');
    },
  },
  {
    name: 'rate limits are classified and carry retryAfterMs',
    needsForce: true,
    async run(h) {
      h.force?.({ kind: 'reject', errorClass: 'rate_limited', retryAfterMs: 30_000 });
      const result = await h.sender.send(h.ctx, makeEmail(h));
      assert(result.kind === 'rejected', this.name, `expected rejected, got ${result.kind}`);
      assert(result.errorClass === 'rate_limited', this.name, `expected rate_limited, got ${result.errorClass}`);
      assert(result.retryAfterMs === 30_000, this.name, 'retryAfterMs not propagated');
    },
  },
  {
    name: 'permanent rejections use the error taxonomy and leak no secrets',
    needsForce: true,
    async run(h) {
      h.force?.({ kind: 'reject', errorClass: 'invalid_recipient' });
      const result = await h.sender.send(h.ctx, makeEmail(h));
      assert(result.kind === 'rejected', this.name, `expected rejected, got ${result.kind}`);
      assert((ERROR_CLASSES as readonly string[]).includes(result.errorClass), this.name, 'unknown error class');
      assertNoSecret(result, h, this.name);
    },
  },
];

/** Runs every applicable case; returns the names of skipped cases. Throws on the first failure. */
export async function runEmailSenderConformance(makeHarness: () => EmailConformanceHarness): Promise<string[]> {
  const skipped: string[] = [];
  for (const testCase of EMAIL_SENDER_CONFORMANCE) {
    const harness = makeHarness();
    if (testCase.needsForce && !harness.force) {
      skipped.push(testCase.name);
      continue;
    }
    await testCase.run(harness);
  }
  return skipped;
}

/** Secret resolver backed by a fixed map; unknown references throw. */
export function staticSecrets(values: Readonly<Record<string, string>>): SecretResolver {
  return {
    async get(ref) {
      const value = values[ref];
      if (value === undefined) throw new Error(`Unknown secret reference ${ref}`);
      return value;
    },
  };
}
