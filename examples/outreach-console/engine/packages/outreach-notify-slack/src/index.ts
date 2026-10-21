import type { ErrorClass, Notification, ProviderAdapter, ProviderContext, SendResult } from '@splitin/outreach-contracts';
import { ProviderNetworkError, textRequest, type HttpDeps } from '@splitin/outreach-provider-kit';

export const SLACK_API = 'https://slack.com/api';

export interface SlackNotifierOptions {
  readonly api?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  /** Allowed incoming-webhook origin; overridable for tests only. */
  readonly webhookOrigin?: string;
}

/**
 * The account's secret decides the mode:
 * - an incoming-webhook URL (https://hooks.slack.com/services/...) posts to that webhook's fixed channel;
 * - a bot token (xoxb-...) posts with chat.postMessage to the channel in the account's externalAccountId.
 */
type Mode = { readonly kind: 'webhook'; readonly url: string } | { readonly kind: 'bot'; readonly token: string };

const SEVERITY = { info: ':information_source:', warning: ':warning:', error: ':rotating_light:' } as const;

/** Slack mrkdwn needs &, < and > escaped; everything the engine sends is data, never markup. */
export const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackBlocks(notification: Notification): { text: string; blocks: unknown[] } {
  const title = `${SEVERITY[notification.severity]} ${escapeSlack(notification.title)}`.slice(0, 3000);
  const lines = notification.lines.map(escapeSlack).join('\n').slice(0, 3000);
  const link = notification.link && /^https:\/\//.test(notification.link) ? notification.link : undefined;
  return {
    // Fallback for notifications and clients without Block Kit.
    text: `${title}${lines ? `\n${lines}` : ''}`.slice(0, 4000),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      ...(lines ? [{ type: 'section', text: { type: 'mrkdwn', text: lines } }] : []),
      ...(link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open' }, url: link }] }] : []),
    ],
  };
}

/** chat.postMessage / auth.test `error` codes to the engine taxonomy. */
export function classifySlackError(code: string): ErrorClass {
  if (code === 'ratelimited' || code === 'rate_limited') return 'rate_limited';
  if (/^(invalid_auth|not_authed|token_revoked|token_expired|account_inactive|no_permission|missing_scope)$/.test(code)) return 'auth_revoked';
  if (/^(channel_not_found|not_in_channel|is_archived|channel_is_archived|restricted_action|no_service|no_service_id|no_team|team_disabled|action_prohibited|posting_to_general_channel_denied)$/.test(code)) return 'forbidden';
  return 'content_rejected';
}

export function slackNotifier(options: SlackNotifierOptions = {}): ProviderAdapter {
  const http: HttpDeps = { fetch: options.fetch ?? fetch, timeoutMs: options.requestTimeoutMs ?? 15_000 };
  const api = options.api ?? SLACK_API;
  const webhookOrigin = options.webhookOrigin ?? 'https://hooks.slack.com';

  const modeOf = async (ctx: ProviderContext): Promise<Mode> => {
    const secret = (await ctx.secrets.get(ctx.secretRef)).trim();
    if (secret.startsWith(`${webhookOrigin}/`)) return { kind: 'webhook', url: secret };
    if (secret.startsWith('xoxb-')) return { kind: 'bot', token: secret };
    throw new Error('the Slack secret must be an incoming-webhook URL (https://hooks.slack.com/...) or a bot token (xoxb-...)');
  };

  const publish = async (ctx: ProviderContext, notification: Notification & { idempotencyKey: string }): Promise<SendResult> => {
    let mode: Mode;
    try {
      mode = await modeOf(ctx);
    } catch (error) {
      return { kind: 'rejected', errorClass: 'auth_revoked', detail: (error as Error).message };
    }
    const payload = slackBlocks(notification);
    let response: { status: number; text: string; retryAfterMs?: number };
    try {
      response = mode.kind === 'webhook'
        ? await textRequest(http, { url: mode.url, method: 'POST', json: payload, signal: ctx.signal })
        : await textRequest(http, { url: `${api}/chat.postMessage`, method: 'POST', token: mode.token, json: { channel: ctx.account.externalAccountId, unfurl_links: false, ...payload }, signal: ctx.signal });
    } catch (error) {
      if (error instanceof ProviderNetworkError && !error.reachedServer) return { kind: 'rejected', errorClass: 'transient', detail: error.message };
      return { kind: 'unknown', detail: error instanceof ProviderNetworkError ? error.message : (error as Error).name };
    }
    if (response.status === 429) return { kind: 'rejected', errorClass: 'rate_limited', retryAfterMs: response.retryAfterMs ?? 30_000, detail: 'Slack HTTP 429' };
    if (response.status >= 500) return { kind: 'unknown', detail: `Slack HTTP ${response.status}` };
    if (mode.kind === 'webhook') {
      // Incoming webhooks answer "ok" or a plain-text error code (invalid_payload, no_service, channel_is_archived...).
      if (response.status === 200 && response.text.trim() === 'ok') {
        return { kind: 'accepted', receipt: { providerMessageId: `webhook:${notification.idempotencyKey}`, acceptedAt: ctx.now() } };
      }
      const code = response.text.trim().slice(0, 60) || `http_${response.status}`;
      return { kind: 'rejected', errorClass: classifySlackError(code), detail: `Slack webhook ${response.status}: ${code}` };
    }
    let body: { ok?: boolean; ts?: string; channel?: string; error?: string } = {};
    try {
      body = JSON.parse(response.text) as typeof body;
    } catch {
      return { kind: 'unknown', detail: `Slack HTTP ${response.status} with an unreadable body` };
    }
    if (body.ok && body.ts) {
      return { kind: 'accepted', receipt: { providerMessageId: `${body.channel ?? ctx.account.externalAccountId}:${body.ts}`, acceptedAt: ctx.now() } };
    }
    const code = body.error ?? `http_${response.status}`;
    return { kind: 'rejected', errorClass: classifySlackError(code), ...(code === 'ratelimited' ? { retryAfterMs: response.retryAfterMs ?? 30_000 } : {}), detail: `Slack ${code}` };
  };

  return {
    name: 'slack',
    purposes: ['transactional'],
    account: {
      async discover(ctx) {
        return {
          provider: 'slack',
          send: false,
          replyInThread: false,
          customHeaders: false,
          externalIdempotency: false,
          inboundWebhook: false,
          mailboxPolling: false,
          reconcileBySentSearch: false,
          maxRecipientsPerMessage: 1,
          discoveredAt: ctx.now(),
        };
      },
      async health(ctx) {
        let mode: Mode;
        try {
          mode = await modeOf(ctx);
        } catch (error) {
          return { status: 'reauth_required', detail: (error as Error).message };
        }
        // An incoming webhook cannot be checked without posting to the channel.
        if (mode.kind === 'webhook') return { status: 'ok', detail: 'incoming webhook (not verifiable without posting)' };
        try {
          const response = await textRequest(http, { url: `${api}/auth.test`, method: 'POST', token: mode.token, signal: ctx.signal });
          const body = JSON.parse(response.text || '{}') as { ok?: boolean; error?: string };
          if (body.ok) return { status: 'ok' };
          const errorClass = classifySlackError(body.error ?? '');
          return { status: errorClass === 'auth_revoked' ? 'reauth_required' : 'degraded', detail: `Slack ${body.error ?? response.status}` };
        } catch (error) {
          return { status: 'degraded', detail: (error as Error).message };
        }
      },
    },
    notify: { publish },
  };
}
