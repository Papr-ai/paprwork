import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovedEmail, ProviderContext, SecretResolver } from '@splitin/outreach-contracts';
import { FakeGraphServer, runEmailSenderConformance, type FakeGraphOptions } from '@splitin/outreach-fakes';
import { authorizeMicrosoft, microsoftRefreshTokenSource, outlookAdapter } from './index';

const servers: FakeGraphServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

/** A writable secret store, like the CLI's file: secrets. */
function memorySecrets(initial: Record<string, string>): SecretResolver & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    get: async (ref) => {
      const value = values[ref];
      if (value === undefined) throw new Error(`unknown ${ref}`);
      return value;
    },
    put: async (ref, value) => {
      values[ref] = value;
    },
  };
}

async function setup(options: FakeGraphOptions & { settleMs?: number; secret?: string } = {}) {
  const server = await new FakeGraphServer(options).start();
  servers.push(server);
  let now = Date.now();
  const secrets = memorySecrets({ 'file:grant.json': options.secret ?? server.grant() });
  const adapter = outlookAdapter({
    api: server.url,
    tokens: microsoftRefreshTokenSource({ authority: server.url }),
    settleMs: options.settleMs ?? 180_000,
    requestTimeoutMs: 2_000,
  });
  const ctx: ProviderContext = {
    workspaceId: 'ws',
    account: { id: 'acct-1', provider: 'outlook', externalAccountId: server.mailbox, sender: { name: 'Sam', address: server.mailbox } },
    secretRef: 'file:grant.json',
    secrets,
    traceId: 'trace',
    signal: new AbortController().signal,
    now: () => now,
  };
  return { server, adapter, ctx, secrets, advance: (ms: number) => (now += ms), email: adapter.email! };
}

function email(overrides: Partial<ApprovedEmail> = {}): ApprovedEmail {
  return {
    actionId: 'a1',
    idempotencyKey: 'act:a1',
    rfcMessageId: '<a1.outreach@example.com>',
    contentHash: 'h',
    from: { address: 'sam@contoso.example', name: 'Sam' },
    to: [{ address: 'ada@example.org' }],
    subject: 'Quick question',
    text: 'Hello Ada',
    headers: { 'List-Unsubscribe': '<mailto:sam@contoso.example?subject=unsubscribe>' },
    ...overrides,
  };
}

const uncertain = (attemptedAt: number) => ({ actionId: 'a1', idempotencyKey: 'act:a1', rfcMessageId: '<a1.outreach@example.com>', to: ['ada@example.org'], attemptedAt });

describe('conformance kit over HTTP', () => {
  it('passes every case, including dropped connections before and after Exchange accepts the send', async () => {
    const harnesses: Awaited<ReturnType<typeof setup>>[] = [];
    for (let i = 0; i < 7; i += 1) harnesses.push(await setup({ settleMs: 0 }));
    let next = 0;
    const skipped = await runEmailSenderConformance(() => {
      const h = harnesses[next++]!;
      return { sender: h.email, ctx: h.ctx, secretValue: 'ms-refresh-1', recipient: 'ada@example.org', force: (mode) => h.server.force(mode) };
    });
    expect(skipped).toEqual([]);
  });
});

describe('send and reconcile', () => {
  it('sends a MIME draft (custom headers intact) and reports the Message-ID Exchange stored', async () => {
    const { email: sender, ctx, server } = await setup({ replaceMessageId: true });
    const result = await sender.send(ctx, email());
    expect(result.kind).toBe('accepted');
    const sent = server.messages.find((m) => m.folder === 'sentitems');
    expect(sent?.headers.find((h) => h.name === 'List-Unsubscribe')?.value).toBe('<mailto:sam@contoso.example?subject=unsubscribe>');
    if (result.kind === 'accepted') expect(result.receipt.rfcMessageId).toBe(sent?.internetMessageId);
    expect(server.messages.filter((m) => m.folder === 'drafts')).toHaveLength(0);
  });

  it('finds a lost send by its idempotency header when Exchange replaced the Message-ID; absent only after settling', async () => {
    const { email: sender, ctx, server, advance } = await setup({ replaceMessageId: true });
    server.force({ kind: 'unknown_after_accept' });
    const at = ctx.now();
    expect((await sender.send(ctx, email())).kind).toBe('unknown');
    expect((await sender.reconcile(ctx, uncertain(at))).kind).toBe('found');

    const second = await setup();
    second.server.force({ kind: 'unknown_before_accept' });
    const at2 = second.ctx.now();
    expect((await second.email.send(second.ctx, email())).kind).toBe('unknown');
    expect((await second.email.reconcile(second.ctx, uncertain(at2))).kind).toBe('still_unknown');
    second.advance(181_000);
    expect(second.server.messages.filter((m) => m.folder === 'drafts')).toHaveLength(1);
    expect((await second.email.reconcile(second.ctx, uncertain(at2))).kind).toBe('absent');
    expect(second.server.messages.filter((m) => m.folder === 'drafts')).toHaveLength(0); // Orphaned draft removed.
    void advance;
  });

  it('treats an unreachable Graph as a transient rejection (a draft never sends) and maps Exchange errors', async () => {
    const { email: sender, ctx, server } = await setup();
    server.force({ kind: 'reject', errorClass: 'policy_blocked' });
    expect(await sender.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'policy_blocked' });
    server.force({ kind: 'reject', errorClass: 'transient' });
    expect((await sender.send(ctx, email())).kind).toBe('unknown');
    server.force({ kind: 'reject', errorClass: 'rate_limited', retryAfterMs: 30_000 });
    expect(await sender.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'rate_limited', retryAfterMs: 30_000 });
    // Refused sends discard their draft; the 5xx (outcome unknown) keeps it until reconciliation decides.
    expect(server.messages.filter((m) => m.folder === 'drafts')).toHaveLength(1);

    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const offline = outlookAdapter({ api: `http://127.0.0.1:${port}`, tokens: { get: async () => 't', invalidate: () => {} }, requestTimeoutMs: 2_000 });
    expect(await offline.email!.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'transient' });
  });
});

describe('tokens', () => {
  it('writes rotated refresh tokens back so the grant does not lapse', async () => {
    const { email: sender, ctx, server, secrets } = await setup({ rotateRefreshTokens: true });
    expect((await sender.send(ctx, email())).kind).toBe('accepted');
    expect(JSON.parse(secrets.values['file:grant.json'] ?? '{}')).toMatchObject({ refreshToken: 'ms-refresh-2', tenant: server.tenant });
    server.validRefreshTokens.delete('ms-refresh-1'); // The old token no longer works; the stored one must.
    server.expireTokens();
    expect(await sender.send(ctx, email())).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
    expect((await sender.send(ctx, email())).kind).toBe('accepted');
  });

  it('reports a revoked grant as auth_revoked and reauth_required', async () => {
    const { adapter, ctx, email: sender } = await setup({ secret: JSON.stringify({ tenant: 'contoso.example', clientId: 'ms-client', refreshToken: 'rt-secret-value-9' }) });
    const result = await sender.send(ctx, email());
    expect(result).toMatchObject({ kind: 'rejected', errorClass: 'auth_revoked' });
    expect(JSON.stringify(result)).not.toContain('rt-secret-value-9');
    expect((await adapter.account.health(ctx)).status).toBe('reauth_required');
  });
});

describe('mailbox', () => {
  it('starts from now, then returns replies and parsed Exchange NDRs', async () => {
    const { adapter, ctx, server } = await setup();
    const first = await adapter.mailbox!.readChanges(ctx, null);
    expect(first.events).toEqual([]);
    server.deliver({
      bodyPreview: 'Sounds good, Thursday?',
      conversationId: 'conv-x',
      mime: 'From: Ada <ada@example.org>\r\nTo: sam@contoso.example\r\nSubject: RE: Quick question\r\nMessage-ID: <r1@example.org>\r\nIn-Reply-To: <a1.outreach@example.com>\r\nReferences: <a1.outreach@example.com>\r\n\r\nSounds good',
    });
    server.deliver({
      mime: [
        'From: postmaster@contoso.example',
        'To: sam@contoso.example',
        'Subject: Undeliverable: Quick question',
        'Content-Type: multipart/report; report-type=delivery-status; boundary="nd"',
        '',
        '--nd',
        'Content-Type: message/delivery-status',
        '',
        'Final-Recipient: rfc822; gone@example.net',
        'Status: 5.1.10',
        '--nd',
        'Content-Type: text/rfc822-headers',
        '',
        'Message-ID: <a2.outreach@example.com>',
        '--nd--',
      ].join('\r\n'),
    });
    const second = await adapter.mailbox!.readChanges(ctx, first.nextCursor);
    const [reply, bounce] = second.events;
    expect(reply).toMatchObject({ kind: 'message', from: 'ada@example.org', providerThreadId: 'conv-x', inReplyTo: '<a1.outreach@example.com>', snippet: 'Sounds good, Thursday?' });
    expect(bounce).toMatchObject({ kind: 'bounce', dsn: { status: '5.1.10', recipient: 'gone@example.net', originalMessageId: '<a2.outreach@example.com>' } });
  });
});

describe('health and purposes', () => {
  it('is ok only for the sender mailbox, and defaults to manual correspondence', async () => {
    const { adapter, ctx } = await setup();
    expect(await adapter.account.health(ctx)).toEqual({ status: 'ok' });
    const other = { ...ctx, account: { ...ctx.account, sender: { name: 'X', address: 'other@contoso.example' } } };
    expect((await adapter.account.health(other)).status).toBe('unhealthy');
    expect(outlookAdapter().purposes).toEqual(['manual_correspondence']);
  });
});

describe('authorizeMicrosoft', () => {
  it('runs the localhost loopback flow with PKCE and returns a grant for the mailbox Graph reports', async () => {
    const server = await new FakeGraphServer().start();
    servers.push(server);
    const result = await authorizeMicrosoft({
      tenant: server.tenant,
      clientId: 'ms-client',
      authority: server.url,
      api: server.url,
      timeoutMs: 5_000,
      onUrl: (url) => void fetch(url),
    });
    expect(result.emailAddress).toBe('sam@contoso.example');
    expect(result.grant).toEqual({ tenant: 'contoso.example', clientId: 'ms-client', refreshToken: 'ms-refresh-1' });
  });
});
