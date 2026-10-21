import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovedEmail, ProviderContext, ProviderAdapter } from '@splitin/outreach-contracts';
import { FakeGmailServer, runEmailSenderConformance, staticSecrets, type FakeGmailOptions } from '@splitin/outreach-fakes';
import { buildMime, gmailAdapter, googleRefreshTokenSource, MimeError } from './index';

const servers: FakeGmailServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function setup(options: FakeGmailOptions & { settleMs?: number; pollBudget?: number; secret?: string } = {}) {
  const server = await new FakeGmailServer(options).start();
  servers.push(server);
  let now = Date.now();
  const secret = options.secret ?? server.grant();
  const adapter = gmailAdapter({
    api: server.url,
    tokens: googleRefreshTokenSource({ tokenUrl: `${server.url}/token` }),
    settleMs: options.settleMs ?? 180_000,
    requestTimeoutMs: 2_000,
    ...(options.pollBudget ? { pollBudget: options.pollBudget } : {}),
  });
  const ctx: ProviderContext = {
    workspaceId: 'ws',
    account: { id: 'acct-1', provider: 'gmail', externalAccountId: server.mailbox, sender: { name: 'Sam Sender', address: server.mailbox } },
    secretRef: 'env:GMAIL',
    secrets: staticSecrets({ 'env:GMAIL': secret }),
    traceId: 'trace',
    signal: new AbortController().signal,
    now: () => now,
  };
  return { server, adapter, ctx, secret, advance: (ms: number) => (now += ms), email: adapter.email! };
}

function email(overrides: Partial<ApprovedEmail> = {}): ApprovedEmail {
  return {
    actionId: 'a1',
    idempotencyKey: 'act:a1',
    rfcMessageId: '<a1.outreach@example.com>',
    contentHash: 'h',
    from: { address: 'sender@example.com', name: 'Sam Sender' },
    to: [{ address: 'ada@example.org', name: 'Ada' }],
    subject: 'Quick question',
    text: 'Hello Ada',
    headers: { 'List-Unsubscribe': '<mailto:sender@example.com?subject=unsubscribe>' },
    ...overrides,
  };
}

describe('conformance kit over HTTP', () => {
  it('passes every case, including dropped connections before and after Gmail accepts', async () => {
    const harnesses: Awaited<ReturnType<typeof setup>>[] = [];
    for (let i = 0; i < 7; i += 1) harnesses.push(await setup({ settleMs: 0 }));
    let next = 0;
    const skipped = await runEmailSenderConformance(() => {
      const h = harnesses[next++]!;
      return { sender: h.email, ctx: h.ctx, secretValue: 'refresh-token-value', recipient: 'ada@example.org', force: (mode) => h.server.force(mode) };
    });
    expect(skipped).toEqual([]);
  });
});

describe('MIME', () => {
  it('encodes non-ASCII names and subjects, keeps custom headers and adds the idempotency header', () => {
    const mime = buildMime(email({ subject: 'Grüße aus München — kurze Frage', to: [{ address: 'jo@example.de', name: 'Jörg Müller' }] }), new Date(0));
    expect(mime).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(mime).toMatch(/^To: =\?UTF-8\?B\?.+\?= <jo@example\.de>$/m);
    expect(mime).toMatch(/^List-Unsubscribe: <mailto:/m);
    expect(mime).toMatch(/^X-Outreach-Key: act:a1$/m);
    expect(mime.split('\r\n').every((line) => line.length <= 998)).toBe(true);
  });

  it('builds multipart/alternative with the text part first', () => {
    const mime = buildMime(email({ html: '<p>Hello Ada</p>' }), new Date(0), 'B');
    expect(mime.indexOf('text/plain')).toBeLessThan(mime.indexOf('text/html'));
    expect(mime).toContain('--B--');
  });

  it('refuses header injection, reserved headers and odd addresses', () => {
    expect(() => buildMime(email({ subject: 'Hi\r\nBcc: victim@example.org' }), new Date(0))).toThrow(MimeError);
    expect(() => buildMime(email({ headers: { Bcc: 'x@example.org' } }), new Date(0))).toThrow(/set by the adapter/);
    expect(() => buildMime(email({ to: [{ address: 'a@b.org>, evil@x.org' }] }), new Date(0))).toThrow(MimeError);
  });
});

describe('send', () => {
  it('reports the Message-ID Gmail stored, so replies correlate even when Gmail rewrites it', async () => {
    const { email: sender, ctx } = await setup({ replaceMessageId: true });
    const result = await sender.send(ctx, email());
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') expect(result.receipt.rfcMessageId).toMatch(/@mail\.gmail\.com>$/);
  });

  it('sends unthreaded when the thread was deleted (the threaded attempt was refused, not sent)', async () => {
    const { email: sender, ctx, server } = await setup();
    const result = await sender.send(ctx, email({ providerThreadId: 'gone' }));
    expect(result.kind).toBe('accepted');
    expect(server.sendCalls).toBe(2);
    expect(server.messages).toHaveLength(1);
  });

  it('maps errors: 5xx is unknown, domain policy is policy_blocked, connection refused is a transient rejection', async () => {
    const { email: sender, ctx, server } = await setup();
    server.force({ kind: 'reject', errorClass: 'transient' });
    expect((await sender.send(ctx, email())).kind).toBe('unknown');
    server.force({ kind: 'reject', errorClass: 'policy_blocked' });
    expect(await sender.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'policy_blocked' });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const offline = gmailAdapter({ api: `http://127.0.0.1:${port}`, tokens: { get: async () => 'token', invalidate: () => {} }, requestTimeoutMs: 2_000 });
    expect(await offline.email!.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'transient' });
  });

  it('refreshes the access token after a 401 and reports a revoked grant as auth_revoked', async () => {
    const { email: sender, ctx, server } = await setup();
    expect((await sender.send(ctx, email())).kind).toBe('accepted');
    server.expireTokens();
    expect(await sender.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
    expect((await sender.send(ctx, email())).kind).toBe('accepted');

    const revoked = await setup({ secret: JSON.stringify({ clientId: 'client-id', clientSecret: 'client-secret-value', refreshToken: 'wrong' }) });
    const result = await revoked.email.send(revoked.ctx, email());
    expect(result).toMatchObject({ kind: 'rejected', errorClass: 'auth_revoked' });
    expect(JSON.stringify(result)).not.toContain('client-secret-value');
  });
});

describe('reconcile', () => {
  it('finds a lost send through the Sent folder when search has not indexed it yet', async () => {
    const { email: sender, ctx, server } = await setup({ searchLag: true });
    server.force({ kind: 'unknown_after_accept' });
    expect((await sender.send(ctx, email())).kind).toBe('unknown');
    const result = await sender.reconcile(ctx, { actionId: 'a1', idempotencyKey: 'act:a1', rfcMessageId: '<a1.outreach@example.com>', to: ['ada@example.org'], attemptedAt: ctx.now() });
    expect(result.kind).toBe('found');
  });

  it('answers absent only after the settle window', async () => {
    const { email: sender, ctx, server, advance } = await setup({ settleMs: 180_000 });
    server.force({ kind: 'unknown_before_accept' });
    const attemptedAt = ctx.now();
    expect((await sender.send(ctx, email())).kind).toBe('unknown');
    const uncertain = { actionId: 'a1', idempotencyKey: 'act:a1', rfcMessageId: '<a1.outreach@example.com>', to: ['ada@example.org'], attemptedAt };
    expect((await sender.reconcile(ctx, uncertain)).kind).toBe('still_unknown');
    advance(181_000);
    expect((await sender.reconcile(ctx, uncertain)).kind).toBe('absent');
  });
});

describe('mailbox', () => {
  const readAll = async (adapter: ProviderAdapter, ctx: ProviderContext, cursor: string | null) => adapter.mailbox!.readChanges(ctx, cursor);

  it('starts from now, then returns replies and parsed bounces but never our own sent mail', async () => {
    const { adapter, ctx, server, email: sender } = await setup();
    server.deliver({ headers: { From: 'old@example.org', Subject: 'before connect' } });
    const first = await readAll(adapter, ctx, null);
    expect(first.events).toEqual([]);

    const sent = await sender.send(ctx, email());
    const threadId = sent.kind === 'accepted' ? sent.receipt.providerThreadId : undefined;
    server.deliver({
      threadId,
      snippet: 'Please remove me from your list &amp; thanks',
      headers: { From: 'Ada <ada@example.org>', To: 'sender@example.com', Subject: 'Re: Quick question', 'Message-ID': '<r1@example.org>', 'In-Reply-To': '<a1.outreach@example.com>', References: '<a1.outreach@example.com>' },
    });
    const dsn = Buffer.from('Reporting-MTA: dns; googlemail.com\r\n\r\nFinal-Recipient: rfc822; gone@example.net\r\nAction: failed\r\nStatus: 5.1.1\r\n').toString('base64url');
    const original = Buffer.from('Message-ID: <a2.outreach@example.com>\r\nSubject: Quick question\r\n').toString('base64url');
    server.deliver({
      headers: { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Failure)', 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' },
      payload: { mimeType: 'multipart/report', parts: [{ mimeType: 'text/plain' }, { mimeType: 'message/delivery-status', body: { data: dsn } }, { mimeType: 'text/rfc822-headers', body: { data: original } }] },
    });

    const second = await readAll(adapter, ctx, first.nextCursor);
    expect(second.events).toHaveLength(2);
    const [reply, bounce] = second.events;
    expect(reply).toMatchObject({ kind: 'message', from: 'ada@example.org', inReplyTo: '<a1.outreach@example.com>', providerThreadId: threadId, snippet: 'Please remove me from your list & thanks' });
    expect(bounce).toMatchObject({ kind: 'bounce', dsn: { status: '5.1.1', recipient: 'gone@example.net', originalMessageId: '<a2.outreach@example.com>' } });
    expect((await readAll(adapter, ctx, second.nextCursor)).events).toEqual([]);
    expect(JSON.stringify(second)).not.toContain('refresh-token-value');
  });

  it('leaves a bounce without a delivery-status part unclassified (status empty) instead of guessing', async () => {
    const { adapter, ctx, server } = await setup();
    const { nextCursor } = await readAll(adapter, ctx, null);
    server.deliver({ headers: { From: 'postmaster@example.net', Subject: 'Undeliverable', 'X-Failed-Recipients': 'x@example.net' } });
    const { events } = await readAll(adapter, ctx, nextCursor);
    expect(events[0]).toMatchObject({ kind: 'bounce', dsn: { status: '' } });
  });

  it('resumes after the budget without skipping, and recovers from an expired cursor', async () => {
    const { adapter, ctx, server } = await setup({ pollBudget: 2, historyPageSize: 1 });
    let cursor = (await readAll(adapter, ctx, null)).nextCursor;
    for (let i = 0; i < 5; i += 1) server.deliver({ headers: { From: `p${i}@example.org`, Subject: `m${i}` } });
    const seen: string[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const result = await readAll(adapter, ctx, cursor);
      seen.push(...result.events.map((event) => event.from));
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(['p0@example.org', 'p1@example.org', 'p2@example.org', 'p3@example.org', 'p4@example.org']);

    server.oldestHistoryId = Number.MAX_SAFE_INTEGER;
    const recovered = await readAll(adapter, ctx, cursor);
    expect(recovered.events.length).toBeGreaterThan(0);
    expect(recovered.events.every((event) => event.eventId.startsWith('gmail:'))).toBe(true);
  });
});

describe('account health', () => {
  it('is ok for the right mailbox, unhealthy for a different one, and asks to reconnect when the grant is revoked', async () => {
    const { adapter, ctx } = await setup();
    expect(await adapter.account.health(ctx)).toEqual({ status: 'ok' });
    const other = { ...ctx, account: { ...ctx.account, sender: { name: 'X', address: 'someone-else@example.com' } } };
    expect((await adapter.account.health(other)).status).toBe('unhealthy');
    const revoked = await setup({ secret: JSON.stringify({ clientId: 'client-id', clientSecret: 'client-secret-value', refreshToken: 'wrong' }) });
    expect((await revoked.adapter.account.health(revoked.ctx)).status).toBe('reauth_required');
  });

  it('defaults to manual correspondence until automated outreach is declared', () => {
    expect(gmailAdapter().purposes).toEqual(['manual_correspondence']);
    expect(gmailAdapter({ purposes: ['automated_outreach'] }).purposes).toEqual(['automated_outreach']);
  });
});
