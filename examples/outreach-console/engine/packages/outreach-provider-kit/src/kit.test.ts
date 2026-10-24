import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { jsonRequest, loopbackAuthorize, parseRawDsn, parseRetryAfter, ProviderNetworkError } from './index';

const signal = new AbortController().signal;
const deps = { fetch, timeoutMs: 2_000 };

describe('jsonRequest', () => {
  it('reports a refused connection as never having reached the server', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error = await jsonRequest(deps, { url: `http://127.0.0.1:${port}/`, method: 'POST', signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderNetworkError);
    expect((error as ProviderNetworkError).reachedServer).toBe(false);
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(new Date(10_000 + 5_000).toUTCString(), 10_000)).toBe(5_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('parseRawDsn', () => {
  it('reads status, recipient and original Message-ID from a multipart/report, including base64 parts', () => {
    const status = Buffer.from('Reporting-MTA: dns; mx.example.net\r\n\r\nFinal-Recipient: rfc822; Gone@Example.net\r\nAction: failed\r\nStatus: 5.1.1\r\n').toString('base64');
    const mime = [
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'Your message could not be delivered.',
      '--b1',
      'Content-Type: message/delivery-status',
      'Content-Transfer-Encoding: base64',
      '',
      status,
      '--b1',
      'Content-Type: text/rfc822-headers',
      '',
      'Message-ID: <orig-1@outreach.example.com>',
      'Subject: Quick question',
      '--b1--',
    ].join('\r\n');
    expect(parseRawDsn(mime)).toEqual({ status: '5.1.1', recipient: 'gone@example.net', originalMessageId: '<orig-1@outreach.example.com>' });
  });

  it('leaves status empty without a delivery-status part', () => {
    expect(parseRawDsn('Content-Type: text/plain\r\n\r\nUndeliverable')).toEqual({ status: '' });
  });
});

describe('loopbackAuthorize', () => {
  it('accepts exactly one callback with the right state and hands the PKCE verifier to the exchange', async () => {
    let authUrl = '';
    const result = loopbackAuthorize({
      authUrl: 'https://auth.example.com/authorize',
      params: { client_id: 'c' },
      redirectHost: 'localhost',
      redirectPath: '/',
      onUrl: (url) => (authUrl = url),
      exchange: async ({ code, verifier, redirectUri }) => ({ code, verifier, redirectUri }),
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const url = new URL(authUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/$/);
    const port = new URL(redirect).port;
    const response = await fetch(`http://127.0.0.1:${port}/?code=abc&state=${url.searchParams.get('state')}`);
    expect(response.status).toBe(200);
    const done = await result;
    expect(done).toMatchObject({ code: 'abc', redirectUri: redirect });
    expect(done.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
