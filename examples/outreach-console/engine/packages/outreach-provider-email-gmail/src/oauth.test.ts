import { afterEach, describe, expect, it } from 'vitest';
import { FakeGmailServer } from '@splitin/outreach-fakes';
import { authorizeGoogle, GMAIL_SCOPES } from './index';

const servers: FakeGmailServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function connect(server: FakeGmailServer, visit: (url: string) => Promise<unknown> = (url) => fetch(url)) {
  return authorizeGoogle({
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    scopes: GMAIL_SCOPES,
    authUrl: `${server.url}/authorize`,
    tokenUrl: `${server.url}/token`,
    api: server.url,
    timeoutMs: 5_000,
    onUrl: (url) => void visit(url), // Stands in for the user's browser: follows Google's redirect to the loopback.
  });
}

describe('authorizeGoogle (loopback + PKCE)', () => {
  it('returns a refresh-token grant and the mailbox Gmail reports', async () => {
    const server = await new FakeGmailServer({ mailbox: 'Sam@Example.com' }).start();
    servers.push(server);
    const result = await connect(server);
    expect(result.emailAddress).toBe('sam@example.com');
    expect(result.grant).toEqual({ clientId: 'client-id', clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value' });
  });

  it('refuses a grant missing a scope the adapter needs', async () => {
    const server = await new FakeGmailServer().start();
    servers.push(server);
    server.grantedScopes = ['https://www.googleapis.com/auth/gmail.send'];
    await expect(connect(server)).rejects.toThrow(/missing scopes: .*gmail\.readonly/);
  });

  it('rejects a callback with the wrong state', async () => {
    const server = await new FakeGmailServer().start();
    servers.push(server);
    const forged = (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
      return fetch(`${redirect.origin}/callback?code=code-1&state=forged`);
    };
    await expect(connect(server, forged)).rejects.toThrow(/mismatched state/);
  });
});
