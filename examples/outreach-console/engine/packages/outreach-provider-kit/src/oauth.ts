import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackAuthorizeOptions<T> {
  /** The provider's authorization endpoint. */
  readonly authUrl: string;
  /** Query parameters besides redirect_uri, state and the PKCE pair (client_id, scope, ...). */
  readonly params: Readonly<Record<string, string>>;
  /**
   * Host in the redirect URI. Google accepts `127.0.0.1`; Microsoft registers `http://localhost`.
   * The listener always binds loopback addresses only.
   */
  readonly redirectHost: '127.0.0.1' | 'localhost';
  /** Path of the redirect URI, e.g. `/callback` (Microsoft's `http://localhost` registration uses `/`). */
  readonly redirectPath?: string;
  /** Receives the URL the user must open. */
  readonly onUrl: (url: string) => void;
  /** Exchanges the authorization code (with the PKCE verifier) for whatever the caller needs. */
  readonly exchange: (input: { code: string; verifier: string; redirectUri: string }) => Promise<T>;
  readonly timeoutMs?: number;
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Outreach engine</title><p style="font:16px system-ui;margin:3rem">${message}</p>`;

async function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * The installed-app authorization code flow with a loopback redirect (RFC 8252): PKCE S256, a random
 * `state`, listeners bound to loopback addresses only, and exactly one callback accepted.
 */
export async function loopbackAuthorize<T>(options: LoopbackAuthorizeOptions<T>): Promise<T> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const path = options.redirectPath ?? '/callback';

  let settle: (value: { code: string } | Error) => void = () => {};
  const callback = new Promise<{ code: string } | Error>((resolve) => (settle = resolve));
  let done = false;
  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path || done) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const ok = !error && code !== null && url.searchParams.get('state') === state;
    done = true;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE(ok ? 'Connected. You can close this tab and return to the terminal.' : 'Authorization failed. Return to the terminal.'));
    settle(ok ? { code } : new Error(error ? `the provider returned ${error}` : 'callback had a missing code or a mismatched state'));
  };

  // `localhost` may resolve to either loopback family in the browser, so listen on both.
  const servers = [createServer(handler)];
  const port = await listen(servers[0]!, '127.0.0.1', 0);
  if (options.redirectHost === 'localhost') {
    const v6 = createServer(handler);
    try {
      await listen(v6, '::1', port);
      servers.push(v6);
    } catch {
      // No IPv6 loopback on this machine; IPv4 is enough.
    }
  }
  const redirectUri = `http://${options.redirectHost}:${port}${path}`;
  try {
    const auth = new URL(options.authUrl);
    auth.search = new URLSearchParams({
      ...options.params,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();
    options.onUrl(auth.toString());
    const timeout = new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('timed out waiting for the sign-in')), options.timeoutMs ?? 300_000).unref());
    const result = await Promise.race([callback, timeout]);
    if (result instanceof Error) throw result;
    return await options.exchange({ code: result.code, verifier, redirectUri });
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  }
}
