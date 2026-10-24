import { describe, expect, it } from 'vitest';
import type { ProviderContext } from '@splitin/outreach-contracts';
import {
  EMAIL_SENDER_CONFORMANCE,
  FAKE_EMAIL_SECRET,
  FAKE_WEBHOOK_SECRET,
  FakeEmailProvider,
  FakeNotifier,
  runEmailSenderConformance,
  staticSecrets,
} from './index';

function ctxFor(): ProviderContext {
  return {
    workspaceId: 'default',
    account: {
      id: 'acct-1',
      provider: 'fake-email',
      externalAccountId: 'ext-1',
      sender: { name: 'Sender', address: 'sender@example.com' },
    },
    secretRef: 'env:FAKE',
    secrets: staticSecrets({ 'env:FAKE': FAKE_EMAIL_SECRET }),
    traceId: 'trace',
    signal: new AbortController().signal,
    now: () => 1_700_000_000_000,
  };
}

function harness(fake = new FakeEmailProvider()) {
  const adapter = fake.adapter();
  if (!adapter.email) throw new Error('fake has no email port');
  return {
    sender: adapter.email,
    ctx: ctxFor(),
    secretValue: FAKE_EMAIL_SECRET,
    recipient: 'lead@example.org',
    force: (mode: Parameters<FakeEmailProvider['script']>[0]) => void fake.script(mode),
  };
}

describe('FakeEmailProvider conformance', () => {
  for (const testCase of EMAIL_SENDER_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(harness());
    });
  }

  it('skips forced cases when the harness cannot force outcomes', async () => {
    const { force: _force, ...unforced } = harness();
    const skipped = await runEmailSenderConformance(() => unforced);
    expect(skipped.length).toBe(EMAIL_SENDER_CONFORMANCE.filter((c) => c.needsForce).length);
  });
});

describe('FakeEmailProvider behaviour', () => {
  it('records deliveries only when the effect happened', async () => {
    const fake = new FakeEmailProvider().script(
      { kind: 'unknown_before_accept' },
      { kind: 'unknown_after_accept' },
      { kind: 'reject', errorClass: 'transient' },
    );
    const h = harness(fake);
    const email = (n: number) => ({
      actionId: `a${n}`,
      idempotencyKey: `k${n}`,
      rfcMessageId: `<m${n}@example.com>`,
      contentHash: 'h',
      from: { address: 'sender@example.com' },
      to: [{ address: 'lead@example.org' }],
      subject: 's',
      text: 't',
      headers: {},
    });
    await h.sender.send(h.ctx, email(1));
    await h.sender.send(h.ctx, email(2));
    await h.sender.send(h.ctx, email(3));
    expect(fake.deliveries.map((d) => d.rfcMessageId)).toEqual(['<m2@example.com>']);
    expect(fake.sendCalls).toBe(3);
  });

  it('rejects a wrong credential as auth_revoked', async () => {
    const fake = new FakeEmailProvider({ secret: 'other-fake-secret' });
    const h = harness(fake);
    const result = await h.sender.send(h.ctx, {
      actionId: 'a',
      idempotencyKey: 'k',
      rfcMessageId: '<m@example.com>',
      contentHash: 'h',
      from: { address: 'sender@example.com' },
      to: [{ address: 'lead@example.org' }],
      subject: 's',
      text: 't',
      headers: {},
    });
    expect(result).toMatchObject({ kind: 'rejected', errorClass: 'auth_revoked' });
  });

  it('threads replies and signs webhooks that verify only when untampered', async () => {
    const fake = new FakeEmailProvider();
    const h = harness(fake);
    const sent = await h.sender.send(h.ctx, {
      actionId: 'a',
      idempotencyKey: 'k',
      rfcMessageId: '<root@example.com>',
      contentHash: 'h',
      from: { address: 'sender@example.com' },
      to: [{ address: 'lead@example.org' }],
      subject: 'Hello',
      text: 't',
      headers: {},
    });
    expect(sent.kind).toBe('accepted');
    const delivery = fake.deliveries[0];
    if (!delivery) throw new Error('no delivery');
    const reply = fake.reply(delivery, { at: 1_700_000_100_000 });
    expect(reply).toMatchObject({ inReplyTo: '<root@example.com>', providerThreadId: delivery.providerThreadId });

    const verifier = fake.adapter().webhook;
    if (!verifier) throw new Error('no webhook port');
    const now = 1_700_000_200_000;
    const signed = fake.signWebhook([reply], now);
    expect(await verifier.verify(signed.rawBody, signed.headers, FAKE_WEBHOOK_SECRET, now)).toEqual([reply]);
    const tampered = new TextEncoder().encode(new TextDecoder().decode(signed.rawBody).replace('lead', 'evil'));
    expect(await verifier.verify(tampered, signed.headers, FAKE_WEBHOOK_SECRET, now)).toBe('reject');
    expect(await verifier.verify(signed.rawBody, signed.headers, FAKE_WEBHOOK_SECRET, now + 6 * 60_000)).toBe('reject');
  });

  it('pages the mailbox by cursor', async () => {
    const fake = new FakeEmailProvider();
    const mailbox = fake.adapter().mailbox;
    if (!mailbox) throw new Error('no mailbox port');
    fake.pushInbound({ kind: 'message', references: [], from: 'a@example.org', to: [], headers: {} });
    const first = await mailbox.readChanges(ctxFor(), null);
    fake.pushInbound({ kind: 'message', references: [], from: 'b@example.org', to: [], headers: {} });
    const second = await mailbox.readChanges(ctxFor(), first.nextCursor);
    expect(first.events.map((e) => e.from)).toEqual(['a@example.org']);
    expect(second.events.map((e) => e.from)).toEqual(['b@example.org']);
  });
});

describe('FakeNotifier', () => {
  it('records accepted notifications and not rejected ones', async () => {
    const notifier = new FakeNotifier().script({ kind: 'reject', errorClass: 'transient' });
    const port = notifier.adapter().notify;
    if (!port) throw new Error('no notify port');
    const note = { title: 't', lines: ['l'], severity: 'info' as const, idempotencyKey: 'n1' };
    expect((await port.publish(ctxFor(), note)).kind).toBe('rejected');
    expect((await port.publish(ctxFor(), note)).kind).toBe('accepted');
    expect(notifier.published).toHaveLength(1);
  });
});
