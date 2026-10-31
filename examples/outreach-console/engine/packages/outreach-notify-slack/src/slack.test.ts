import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderContext } from '@splitin/outreach-contracts';
import { escapeSlack, slackBlocks, slackNotifier } from './index';

interface Received {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

/** Minimal Slack: /services/* incoming webhooks, /api/chat.postMessage and /api/auth.test. */
async function fakeSlack(reply: (req: Received) => { status: number; body: string; headers?: Record<string, string> } | 'drop') {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry = { path: req.url ?? '', auth: req.headers.authorization, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
      received.push(entry);
      const answer = reply(entry);
      if (answer === 'drop') return void req.socket.destroy();
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url, received };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

function ctx(secret: string, channel = 'C0123'): ProviderContext {
  return {
    workspaceId: 'ws',
    account: { id: 'slack-1', provider: 'slack', externalAccountId: channel, sender: { name: 'Outreach', address: 'ops@example.com' } },
    secretRef: 'env:SLACK',
    secrets: { get: async () => secret },
    traceId: 't',
    signal: new AbortController().signal,
    now: () => 1_000,
  };
}

const note = { title: 'Reply from <ada@example.org>', lines: ['Campaign: Intro & friends'], severity: 'info' as const, idempotencyKey: 'inbound:1' };

describe('Slack notifier', () => {
  it('posts escaped Block Kit through an incoming webhook', async () => {
    const slack = await fakeSlack(() => ({ status: 200, body: 'ok' }));
    const notifier = slackNotifier({ webhookOrigin: slack.url });
    const result = await notifier.notify!.publish(ctx(`${slack.url}/services/T/B/x`), note);
    expect(result).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'webhook:inbound:1' } });
    expect(JSON.stringify(slack.received[0]?.body)).toContain('Reply from &lt;ada@example.org&gt;');
    expect(JSON.stringify(slack.received[0]?.body)).toContain('Intro &amp; friends');
  });

  it('posts with a bot token to the account channel and maps Slack error codes', async () => {
    let answer = { ok: true, ts: '1712.0001', channel: 'C0123' } as Record<string, unknown>;
    const slack = await fakeSlack((req) => ({ status: 200, body: JSON.stringify(req.path.endsWith('auth.test') ? { ok: true } : answer) }));
    const notifier = slackNotifier({ api: `${slack.url}/api` });
    const bot = ctx('xoxb-fake');
    expect(await notifier.notify!.publish(bot, note)).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'C0123:1712.0001' } });
    expect(slack.received[0]).toMatchObject({ path: '/api/chat.postMessage', auth: 'Bearer xoxb-fake', body: { channel: 'C0123' } });
    answer = { ok: false, error: 'channel_not_found' };
    expect(await notifier.notify!.publish(bot, note)).toMatchObject({ kind: 'rejected', errorClass: 'forbidden' });
    answer = { ok: false, error: 'token_revoked' };
    expect(await notifier.notify!.publish(bot, note)).toMatchObject({ kind: 'rejected', errorClass: 'auth_revoked' });
    answer = { ok: false, error: 'ratelimited' };
    expect(await notifier.notify!.publish(bot, note)).toMatchObject({ kind: 'rejected', errorClass: 'rate_limited' });
    expect(await notifier.account.health(bot)).toEqual({ status: 'ok' });
  });

  it('is unknown only when the post may have landed', async () => {
    const slack = await fakeSlack(() => 'drop');
    const notifier = slackNotifier({ webhookOrigin: slack.url, requestTimeoutMs: 2_000 });
    expect((await notifier.notify!.publish(ctx(`${slack.url}/services/T/B/x`), note)).kind).toBe('unknown');
    const closed = createTcpServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = slackNotifier({ webhookOrigin: `http://127.0.0.1:${port}` });
    expect(await unreachable.notify!.publish(ctx(`http://127.0.0.1:${port}/services/T/B/x`), note)).toMatchObject({ kind: 'rejected', errorClass: 'transient' });
  });

  it('refuses a secret that is neither a webhook URL nor a bot token, and drops non-https links', async () => {
    const notifier = slackNotifier();
    expect(await notifier.notify!.publish(ctx('https://evil.example.com/hook'), note)).toMatchObject({ kind: 'rejected', errorClass: 'auth_revoked' });
    expect((await notifier.account.health(ctx('nope'))).status).toBe('reauth_required');
    expect(JSON.stringify(slackBlocks({ ...note, link: 'javascript:alert(1)' }))).not.toContain('javascript:');
    expect(escapeSlack('<!channel>')).toBe('&lt;!channel&gt;');
  });
});
