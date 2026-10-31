import { loopbackAuthorize } from '@splitin/outreach-provider-kit';
import { GRAPH_SCOPES, MICROSOFT_AUTHORITY, tokenEndpoint, type MicrosoftGrant } from './token';

export interface MicrosoftAuthorizeOptions {
  /** Directory (tenant) id or domain. `organizations` works for any work account but prefer your tenant. */
  readonly tenant: string;
  readonly clientId: string;
  /** Only for confidential (web) app registrations; desktop registrations are public clients. */
  readonly clientSecret?: string;
  readonly loginHint?: string;
  readonly onUrl: (url: string) => void;
  readonly authority?: string;
  readonly api?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface MicrosoftAuthorization {
  readonly grant: MicrosoftGrant;
  /** The mailbox that granted access, read from Graph itself. */
  readonly emailAddress: string;
  readonly scopes: readonly string[];
}

const short = (scope: string) => scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();

/**
 * Microsoft identity platform authorization code flow for a desktop registration whose redirect URI is
 * `http://localhost` (any port is accepted for loopback). Resolves with a refresh-token grant.
 */
export async function authorizeMicrosoft(options: MicrosoftAuthorizeOptions): Promise<MicrosoftAuthorization> {
  const doFetch = options.fetch ?? fetch;
  const authority = options.authority ?? MICROSOFT_AUTHORITY;
  return loopbackAuthorize({
    authUrl: `${authority}/${encodeURIComponent(options.tenant)}/oauth2/v2.0/authorize`,
    params: {
      client_id: options.clientId,
      scope: GRAPH_SCOPES.join(' '),
      response_mode: 'query',
      prompt: 'select_account',
      ...(options.loginHint ? { login_hint: options.loginHint } : {}),
    },
    redirectHost: 'localhost',
    redirectPath: '/',
    onUrl: options.onUrl,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    exchange: async ({ code, verifier, redirectUri }) => {
      const exchange = await doFetch(tokenEndpoint(authority, options.tenant), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: GRAPH_SCOPES.join(' '),
        }).toString(),
      });
      const tokens = (await exchange.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
      if (!exchange.ok || !tokens.access_token) throw new Error(`token exchange failed (${tokens.error ?? `HTTP ${exchange.status}`})`);
      if (!tokens.refresh_token) throw new Error('Microsoft returned no refresh token; the offline_access permission is missing');
      const granted = (tokens.scope ?? '').split(' ').filter(Boolean).map(short);
      const missing = GRAPH_SCOPES.filter((scope) => scope !== 'offline_access' && !granted.includes(short(scope)));
      if (missing.length) throw new Error(`the grant is missing permissions: ${missing.map(short).join(', ')} (an admin may need to consent)`);
      const me = await doFetch(new URL('/v1.0/me?$select=mail,userPrincipalName', options.api ?? 'https://graph.microsoft.com'), {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      const profile = (await me.json().catch(() => ({}))) as { mail?: string | null; userPrincipalName?: string };
      const address = (profile.mail ?? profile.userPrincipalName ?? '').toLowerCase();
      if (!me.ok || !address) throw new Error(`could not read the connected mailbox (HTTP ${me.status})`);
      return {
        grant: { tenant: options.tenant, clientId: options.clientId, ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}), refreshToken: tokens.refresh_token },
        emailAddress: address,
        scopes: granted,
      };
    },
  });
}
