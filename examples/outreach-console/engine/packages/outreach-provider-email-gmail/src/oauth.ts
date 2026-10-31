import { loopbackAuthorize } from '@splitin/outreach-provider-kit';
import { GOOGLE_TOKEN_URL, type GoogleGrant } from './token';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleAuthorizeOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** Pre-selects the mailbox in Google's account chooser. */
  readonly loginHint?: string;
  /** Receives the URL the user must open; the CLI prints it (and may open a browser). */
  readonly onUrl: (url: string) => void;
  readonly authUrl?: string;
  readonly tokenUrl?: string;
  readonly api?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface GoogleAuthorization {
  readonly grant: GoogleGrant;
  /** The mailbox that granted access, read from Gmail itself (not from what the user typed). */
  readonly emailAddress: string;
  readonly scopes: readonly string[];
}

/** Google's installed-app flow (loopback redirect, PKCE). Resolves with a refresh-token grant. */
export async function authorizeGoogle(options: GoogleAuthorizeOptions): Promise<GoogleAuthorization> {
  const doFetch = options.fetch ?? fetch;
  return loopbackAuthorize({
    authUrl: options.authUrl ?? GOOGLE_AUTH_URL,
    params: {
      client_id: options.clientId,
      scope: options.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      ...(options.loginHint ? { login_hint: options.loginHint } : {}),
    },
    redirectHost: '127.0.0.1',
    onUrl: options.onUrl,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    exchange: async ({ code, verifier, redirectUri }) => {
      const exchange = await doFetch(options.tokenUrl ?? GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      const tokens = (await exchange.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
      if (!exchange.ok || !tokens.access_token) throw new Error(`token exchange failed (${tokens.error ?? `HTTP ${exchange.status}`})`);
      if (!tokens.refresh_token) throw new Error('Google returned no refresh token; remove the app under myaccount.google.com/permissions and connect again');
      const granted = (tokens.scope ?? options.scopes.join(' ')).split(' ');
      const missing = options.scopes.filter((scope) => !granted.includes(scope));
      if (missing.length) throw new Error(`the grant is missing scopes: ${missing.join(', ')} (tick every box on the consent screen)`);
      const profile = await doFetch(new URL('/gmail/v1/users/me/profile', options.api ?? 'https://gmail.googleapis.com'), {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      const body = (await profile.json().catch(() => ({}))) as { emailAddress?: string };
      if (!profile.ok || !body.emailAddress) throw new Error(`could not read the connected mailbox (HTTP ${profile.status})`);
      return {
        grant: { clientId: options.clientId, clientSecret: options.clientSecret, refreshToken: tokens.refresh_token },
        emailAddress: body.emailAddress.toLowerCase(),
        scopes: granted,
      };
    },
  });
}
