import { TokenError, type AccessTokenSource, type AccountPort, type ProviderAdapter, type ProviderPurpose } from '@splitin/outreach-contracts';
import { ProviderNetworkError } from '@splitin/outreach-provider-kit';
import { GMAIL_API, gmailRequest, type HttpDeps } from './http';
import { gmailMailbox } from './mailbox';
import { gmailSender } from './sender';
import { googleRefreshTokenSource } from './token';

export { buildMime, IDEMPOTENCY_HEADER, MimeError } from '@splitin/outreach-contracts';
export { classifyGmailError, GMAIL_API } from './http';
export { authorizeGoogle, GOOGLE_AUTH_URL, type GoogleAuthorization, type GoogleAuthorizeOptions } from './oauth';
export { GOOGLE_TOKEN_URL, googleRefreshTokenSource, parseGoogleGrant, type GoogleGrant, type GoogleTokenOptions } from './token';

/** OAuth scopes the adapter needs: send, plus read for reconciliation (Sent search) and replies (History). */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'] as const;

export interface GmailAdapterOptions {
  /**
   * Purposes this adapter may be used for. Defaults to `manual_correspondence` only: declare
   * `automated_outreach` after reviewing Google's terms for your account (BUILD_PLAN.md §19 D1).
   */
  readonly purposes?: readonly ProviderPurpose[];
  /** Where access tokens come from. Defaults to a refresh token stored behind the account's secretRef. */
  readonly tokens?: AccessTokenSource;
  readonly api?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  /** See SenderOptions.settleMs. Default 3 minutes. */
  readonly settleMs?: number;
  /** Messages read per mailbox poll. Default 200. */
  readonly pollBudget?: number;
}

/** The Gmail adapter: sends as the connected mailbox user through the Gmail API. */
export function gmailAdapter(options: GmailAdapterOptions = {}): ProviderAdapter {
  const doFetch = options.fetch ?? fetch;
  const http: HttpDeps = { api: options.api ?? GMAIL_API, fetch: doFetch, timeoutMs: options.requestTimeoutMs ?? 30_000 };
  const tokens = options.tokens ?? googleRefreshTokenSource({ fetch: doFetch });

  const account: AccountPort = {
    async discover(ctx) {
      return {
        provider: 'gmail',
        send: true,
        replyInThread: true,
        customHeaders: true,
        externalIdempotency: false,
        inboundWebhook: false,
        mailboxPolling: true,
        reconcileBySentSearch: true,
        maxRecipientsPerMessage: 100,
        discoveredAt: ctx.now(),
      };
    },
    async health(ctx) {
      let token: string;
      try {
        token = await tokens.get(ctx);
      } catch (error) {
        if (error instanceof TokenError && (error.errorClass === 'auth_revoked' || error.errorClass === 'auth_expired')) {
          return { status: 'reauth_required', detail: error.message };
        }
        return { status: 'degraded', detail: (error as Error).message };
      }
      try {
        const profile = await gmailRequest(http, ctx, token, 'GET', '/gmail/v1/users/me/profile');
        if (profile.status === 200) {
          const address = typeof profile.body.emailAddress === 'string' ? profile.body.emailAddress.toLowerCase() : '';
          if (address && address !== ctx.account.sender.address.toLowerCase()) {
            return { status: 'unhealthy', detail: `connected mailbox is ${address}, not the sender ${ctx.account.sender.address}` };
          }
          return { status: 'ok' };
        }
        if (profile.status === 401) {
          tokens.invalidate(ctx);
          return { status: 'reauth_required', detail: 'Gmail rejected the access token' };
        }
        if (profile.status === 403) return { status: 'unhealthy', detail: 'Gmail refused access (scopes or account policy)' };
        return { status: 'degraded', detail: `Gmail HTTP ${profile.status}` };
      } catch (error) {
        return { status: 'degraded', detail: error instanceof ProviderNetworkError ? error.message : (error as Error).name };
      }
    },
  };

  return {
    name: 'gmail',
    purposes: options.purposes ?? ['manual_correspondence'],
    account,
    email: gmailSender({ http, tokens, settleMs: options.settleMs ?? 180_000 }),
    mailbox: gmailMailbox({ http, tokens, ...(options.pollBudget ? { budget: options.pollBudget } : {}) }),
  };
}
