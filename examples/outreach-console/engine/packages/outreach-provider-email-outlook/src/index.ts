import { TokenError, type AccessTokenSource, type AccountPort, type ProviderAdapter, type ProviderPurpose } from '@splitin/outreach-contracts';
import { ProviderNetworkError } from '@splitin/outreach-provider-kit';
import { GRAPH_API, graphGet, type HttpDeps } from './graph';
import { outlookMailbox } from './mailbox';
import { outlookSender } from './sender';
import { microsoftRefreshTokenSource } from './token';

export { classifyGraphError, GRAPH_API } from './graph';
export { authorizeMicrosoft, type MicrosoftAuthorization, type MicrosoftAuthorizeOptions } from './oauth';
export { GRAPH_SCOPES, MICROSOFT_AUTHORITY, microsoftRefreshTokenSource, parseMicrosoftGrant, type MicrosoftGrant, type MicrosoftTokenOptions } from './token';

export interface OutlookAdapterOptions {
  /**
   * Purposes this adapter may be used for. Defaults to `manual_correspondence` only: declare
   * `automated_outreach` after reviewing Microsoft's terms for your tenant (BUILD_PLAN.md §19 D1).
   */
  readonly purposes?: readonly ProviderPurpose[];
  /** Where access tokens come from. Defaults to a (rotating) refresh token behind the account's secretRef. */
  readonly tokens?: AccessTokenSource;
  readonly api?: string;
  readonly authority?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  /** See SenderOptions.settleMs. Default 3 minutes. */
  readonly settleMs?: number;
  /** Messages read per mailbox poll. Default 200. */
  readonly pollBudget?: number;
}

/** The Outlook adapter: sends as the connected Exchange Online mailbox through Microsoft Graph. */
export function outlookAdapter(options: OutlookAdapterOptions = {}): ProviderAdapter {
  const doFetch = options.fetch ?? fetch;
  const http: HttpDeps = { api: options.api ?? GRAPH_API, fetch: doFetch, timeoutMs: options.requestTimeoutMs ?? 30_000 };
  const tokens = options.tokens ?? microsoftRefreshTokenSource({ fetch: doFetch, ...(options.authority ? { authority: options.authority } : {}) });

  const account: AccountPort = {
    async discover(ctx) {
      return {
        provider: 'outlook',
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
        const me = await graphGet(http, ctx, token, '/me', { $select: 'mail,userPrincipalName' });
        if (me.status === 200) {
          const addresses = [me.body.mail, me.body.userPrincipalName].filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
          if (!addresses.includes(ctx.account.sender.address.toLowerCase())) {
            return { status: 'unhealthy', detail: `connected mailbox is ${addresses[0] ?? 'unknown'}, not the sender ${ctx.account.sender.address}` };
          }
          return { status: 'ok' };
        }
        if (me.status === 401) {
          tokens.invalidate(ctx);
          return { status: 'reauth_required', detail: 'Graph rejected the access token' };
        }
        if (me.status === 403) return { status: 'unhealthy', detail: 'Graph refused access (permissions or tenant policy)' };
        return { status: 'degraded', detail: `Graph HTTP ${me.status}` };
      } catch (error) {
        return { status: 'degraded', detail: error instanceof ProviderNetworkError ? error.message : (error as Error).name };
      }
    },
  };

  return {
    name: 'outlook',
    purposes: options.purposes ?? ['manual_correspondence'],
    account,
    email: outlookSender({ http, tokens, settleMs: options.settleMs ?? 180_000 }),
    mailbox: outlookMailbox({ http, tokens, ...(options.pollBudget ? { budget: options.pollBudget } : {}) }),
  };
}
