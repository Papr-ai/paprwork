import { TokenError, type AccessTokenSource, type ProviderContext } from '@splitin/outreach-contracts';

export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com';

/** Delegated Graph permissions the adapter needs. Mail.ReadWrite covers creating drafts and reading replies. */
export const GRAPH_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/User.Read',
] as const;

/** What the account's `secretRef` resolves to. `clientSecret` is absent for public (desktop) clients. */
export interface MicrosoftGrant {
  readonly tenant: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
}

export function parseMicrosoftGrant(raw: string): MicrosoftGrant {
  let value: Partial<MicrosoftGrant>;
  try {
    value = JSON.parse(raw) as Partial<MicrosoftGrant>;
  } catch {
    throw new TokenError('auth_revoked', 'the Outlook account secret is not JSON {tenant, clientId, refreshToken}');
  }
  if (typeof value.tenant !== 'string' || typeof value.clientId !== 'string' || typeof value.refreshToken !== 'string') {
    throw new TokenError('auth_revoked', 'the Outlook account secret must hold tenant, clientId and refreshToken');
  }
  return value as MicrosoftGrant;
}

export const tokenEndpoint = (authority: string, tenant: string) => `${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

export interface MicrosoftTokenOptions {
  readonly authority?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Access tokens from the refresh token behind `secretRef`. Microsoft rotates refresh tokens on every use;
 * the new one is written back through `secrets.put` when the resolver supports it, so the grant does not
 * lapse. Error messages never contain the secret or tokens.
 */
export function microsoftRefreshTokenSource(options: MicrosoftTokenOptions = {}): AccessTokenSource {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const doFetch = options.fetch ?? fetch;
  const key = (ctx: ProviderContext) => `${ctx.account.id}\u0000${ctx.secretRef}`;
  return {
    async get(ctx) {
      const cached = cache.get(key(ctx));
      if (cached && cached.expiresAt > ctx.now()) return cached.token;
      const grant = parseMicrosoftGrant(await ctx.secrets.get(ctx.secretRef));
      let response: Response;
      try {
        response = await doFetch(tokenEndpoint(options.authority ?? MICROSOFT_AUTHORITY, grant.tenant), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: grant.clientId,
            ...(grant.clientSecret ? { client_secret: grant.clientSecret } : {}),
            refresh_token: grant.refreshToken,
            grant_type: 'refresh_token',
            scope: GRAPH_SCOPES.join(' '),
          }).toString(),
          signal: ctx.signal,
        });
      } catch {
        throw new TokenError('transient', 'the Microsoft token endpoint could not be reached');
      }
      const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
      if (!response.ok || typeof body.access_token !== 'string') {
        if (body.error === 'invalid_grant' || body.error === 'interaction_required' || body.error === 'invalid_client' || body.error === 'unauthorized_client') {
          throw new TokenError('auth_revoked', `Microsoft refused the stored grant (${body.error}); reconnect the account`);
        }
        const errorClass = response.status >= 500 || response.status === 429 ? 'transient' : 'auth_expired';
        throw new TokenError(errorClass, `token refresh failed with HTTP ${response.status}`);
      }
      if (body.refresh_token && body.refresh_token !== grant.refreshToken && ctx.secrets.put) {
        // Best effort: if the write fails, the current refresh token stays valid until its own expiry.
        await ctx.secrets.put(ctx.secretRef, JSON.stringify({ ...grant, refreshToken: body.refresh_token })).catch(() => {});
      }
      const lifetimeSeconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
      cache.set(key(ctx), { token: body.access_token, expiresAt: ctx.now() + Math.max(0, lifetimeSeconds - 60) * 1000 });
      return body.access_token;
    },
    invalidate(ctx) {
      cache.delete(key(ctx));
    },
  };
}
