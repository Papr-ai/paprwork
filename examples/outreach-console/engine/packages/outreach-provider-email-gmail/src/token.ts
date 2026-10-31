import { TokenError, type AccessTokenSource, type ProviderContext } from '@splitin/outreach-contracts';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** What the account's `secretRef` must resolve to: a JSON object from an installed-app OAuth grant. */
export interface GoogleGrant {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export function parseGoogleGrant(raw: string): GoogleGrant {
  let value: Partial<GoogleGrant>;
  try {
    value = JSON.parse(raw) as Partial<GoogleGrant>;
  } catch {
    throw new TokenError('auth_revoked', 'the Gmail account secret is not JSON {clientId, clientSecret, refreshToken}');
  }
  if (typeof value.clientId !== 'string' || typeof value.clientSecret !== 'string' || typeof value.refreshToken !== 'string') {
    throw new TokenError('auth_revoked', 'the Gmail account secret must hold clientId, clientSecret and refreshToken');
  }
  return value as GoogleGrant;
}

export interface GoogleTokenOptions {
  readonly tokenUrl?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Access tokens from a refresh token held behind the account's `secretRef`, cached per account until one
 * minute before expiry. Error messages never contain the secret or the tokens.
 */
export function googleRefreshTokenSource(options: GoogleTokenOptions = {}): AccessTokenSource {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const doFetch = options.fetch ?? fetch;
  const key = (ctx: ProviderContext) => `${ctx.account.id}\u0000${ctx.secretRef}`;
  return {
    async get(ctx) {
      const cached = cache.get(key(ctx));
      if (cached && cached.expiresAt > ctx.now()) return cached.token;
      const grant = parseGoogleGrant(await ctx.secrets.get(ctx.secretRef));
      let response: Response;
      try {
        response = await doFetch(options.tokenUrl ?? GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: grant.clientId,
            client_secret: grant.clientSecret,
            refresh_token: grant.refreshToken,
            grant_type: 'refresh_token',
          }).toString(),
          signal: ctx.signal,
        });
      } catch {
        throw new TokenError('transient', 'the Google token endpoint could not be reached');
      }
      const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
      if (!response.ok || typeof body.access_token !== 'string') {
        if (body.error === 'invalid_grant' || body.error === 'invalid_client' || body.error === 'unauthorized_client') {
          throw new TokenError('auth_revoked', `Google refused the stored grant (${body.error}); reconnect the account`);
        }
        const errorClass = response.status >= 500 || response.status === 429 ? 'transient' : 'auth_expired';
        throw new TokenError(errorClass, `token refresh failed with HTTP ${response.status}`);
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
