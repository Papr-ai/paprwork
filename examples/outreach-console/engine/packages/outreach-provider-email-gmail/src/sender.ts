import {
  TokenError,
  type AccessTokenSource,
  type ApprovedEmail,
  type EmailSender,
  type ProviderContext,
  type ProviderReceipt,
  type ReconcileResult,
  type SendResult,
  type UncertainEmail,
} from '@splitin/outreach-contracts';
import { ProviderNetworkError } from '@splitin/outreach-provider-kit';
import { classifyGmailError, gmailRequest, type GmailResponse, type HttpDeps } from './http';
import { buildMime, IDEMPOTENCY_HEADER, MimeError } from '@splitin/outreach-contracts';

export interface SenderOptions {
  readonly http: HttpDeps;
  readonly tokens: AccessTokenSource;
  /**
   * How long after an attempt the Sent folder must be free of the message before reconciliation may answer
   * "absent". Covers a request Gmail accepted after our timeout fired.
   */
  readonly settleMs: number;
  /** How far back from the attempt the Sent scan looks, to allow for clock skew. */
  readonly scanWindowMs?: number;
  /** Upper bound on Sent messages inspected per reconciliation. */
  readonly scanLimit?: number;
}

const USERS_ME = '/gmail/v1/users/me';

function tokenFailure(error: unknown): { errorClass: TokenError['errorClass']; detail: string } {
  if (error instanceof TokenError) return { errorClass: error.errorClass, detail: error.message };
  return { errorClass: 'transient', detail: `token unavailable (${(error as Error).name})` };
}

function headerValue(message: Record<string, unknown>, name: string): string | undefined {
  const headers = ((message.payload as { headers?: { name?: string; value?: string }[] } | undefined)?.headers ?? []);
  return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;
}

export function gmailSender(options: SenderOptions): EmailSender {
  const { http, tokens } = options;
  const scanWindowMs = options.scanWindowMs ?? 15 * 60_000;
  const scanLimit = options.scanLimit ?? 200;

  const receiptFor = async (ctx: ProviderContext, token: string, id: string, threadId: string | undefined): Promise<ProviderReceipt> => {
    // Gmail may assign its own Message-ID; replies reference the stored one, so read it back (best effort).
    let rfcMessageId: string | undefined;
    try {
      const stored = await gmailRequest(http, ctx, token, 'GET', `${USERS_ME}/messages/${encodeURIComponent(id)}`, {
        query: { format: 'metadata', metadataHeaders: ['Message-ID'] },
      });
      if (stored.status === 200) rfcMessageId = headerValue(stored.body, 'Message-ID');
    } catch {
      // The send is accepted either way; the engine falls back to the Message-ID it generated.
    }
    return {
      providerMessageId: id,
      ...(threadId ? { providerThreadId: threadId } : {}),
      ...(rfcMessageId ? { rfcMessageId } : {}),
      acceptedAt: ctx.now(),
      raw: { gmailId: id, ...(threadId ? { gmailThreadId: threadId } : {}) },
    };
  };

  const post = (ctx: ProviderContext, token: string, raw: string, threadId: string | undefined): Promise<GmailResponse> =>
    gmailRequest(http, ctx, token, 'POST', `${USERS_ME}/messages/send`, { json: { raw, ...(threadId ? { threadId } : {}) } });

  return {
    async send(ctx, email: ApprovedEmail): Promise<SendResult> {
      let raw: string;
      try {
        raw = Buffer.from(buildMime(email, new Date(ctx.now())), 'utf8').toString('base64url');
      } catch (error) {
        if (error instanceof MimeError) return { kind: 'rejected', errorClass: 'content_rejected', detail: error.message };
        throw error;
      }
      let token: string;
      try {
        token = await tokens.get(ctx);
      } catch (error) {
        return { kind: 'rejected', ...tokenFailure(error) };
      }
      let response: GmailResponse;
      try {
        response = await post(ctx, token, raw, email.providerThreadId);
        // A thread the user deleted is refused outright (nothing sent), so sending unthreaded is safe. On send
        // the thread is the only entity that can be missing, so any 404 with a thread id means that.
        const staleThread = response.status === 404 || (response.status === 400 && /thread/i.test(JSON.stringify(response.body)));
        if (email.providerThreadId && staleThread) {
          response = await post(ctx, token, raw, undefined);
        }
      } catch (error) {
        if (error instanceof ProviderNetworkError && !error.reachedServer) return { kind: 'rejected', errorClass: 'transient', detail: error.message };
        return { kind: 'unknown', detail: error instanceof ProviderNetworkError ? error.message : `send failed (${(error as Error).name})` };
      }
      if (response.status === 200 && typeof response.body.id === 'string') {
        const threadId = typeof response.body.threadId === 'string' ? response.body.threadId : undefined;
        return { kind: 'accepted', receipt: await receiptFor(ctx, token, response.body.id, threadId) };
      }
      if (response.status === 401) tokens.invalidate(ctx);
      const rejected = classifyGmailError(response);
      if (!rejected) return { kind: 'unknown', detail: `Gmail HTTP ${response.status} on send` };
      return { kind: 'rejected', ...rejected };
    },

    async reconcile(ctx, email: UncertainEmail): Promise<ReconcileResult> {
      let token: string;
      try {
        token = await tokens.get(ctx);
      } catch (error) {
        return { kind: 'still_unknown', detail: tokenFailure(error).detail };
      }
      try {
        const matches = async (id: string): Promise<ProviderReceipt | 'older' | null> => {
          const message = await gmailRequest(http, ctx, token, 'GET', `${USERS_ME}/messages/${encodeURIComponent(id)}`, {
            query: { format: 'metadata', metadataHeaders: ['Message-ID', IDEMPOTENCY_HEADER] },
          });
          if (message.status !== 200) return null;
          const key = headerValue(message.body, IDEMPOTENCY_HEADER);
          const rfc = headerValue(message.body, 'Message-ID');
          if (key === email.idempotencyKey || rfc === email.rfcMessageId) {
            const threadId = typeof message.body.threadId === 'string' ? message.body.threadId : undefined;
            return {
              providerMessageId: id,
              ...(threadId ? { providerThreadId: threadId } : {}),
              ...(rfc ? { rfcMessageId: rfc } : {}),
              acceptedAt: Number(message.body.internalDate) || ctx.now(),
              raw: { gmailId: id, via: 'reconcile' },
            };
          }
          return Number(message.body.internalDate) < email.attemptedAt - scanWindowMs ? 'older' : null;
        };

        // Fast path: the search index usually has the message within seconds.
        const search = await gmailRequest(http, ctx, token, 'GET', `${USERS_ME}/messages`, {
          query: { q: `rfc822msgid:${email.rfcMessageId.replace(/^<|>$/g, '')}`, includeSpamTrash: 'true', maxResults: '5' },
        });
        if (search.status === 401) {
          tokens.invalidate(ctx);
          return { kind: 'still_unknown', detail: 'access token rejected; retrying with a fresh one next time' };
        }
        for (const hit of (search.body.messages as { id: string }[] | undefined) ?? []) {
          const found = await matches(hit.id);
          if (found && found !== 'older') return { kind: 'found', receipt: found };
        }

        // Authoritative path: walk the Sent label newest first, independent of search indexing.
        let pageToken: string | undefined;
        let inspected = 0;
        let reachedOlder = false;
        scan: do {
          const page = await gmailRequest(http, ctx, token, 'GET', `${USERS_ME}/messages`, {
            query: { labelIds: 'SENT', includeSpamTrash: 'true', maxResults: '50', pageToken },
          });
          if (page.status !== 200) return { kind: 'still_unknown', detail: `Sent scan failed with HTTP ${page.status}` };
          for (const item of (page.body.messages as { id: string }[] | undefined) ?? []) {
            inspected += 1;
            const found = await matches(item.id);
            if (found === 'older') {
              reachedOlder = true;
              break scan;
            }
            if (found) return { kind: 'found', receipt: found };
            if (inspected >= scanLimit) break scan;
          }
          pageToken = typeof page.body.nextPageToken === 'string' ? page.body.nextPageToken : undefined;
          if (!pageToken) reachedOlder = true; // The whole Sent folder was inspected.
        } while (pageToken);

        if (!reachedOlder) return { kind: 'still_unknown', detail: `Sent folder not fully scanned (${inspected} messages inspected)` };
        if (ctx.now() - email.attemptedAt < options.settleMs) return { kind: 'still_unknown', detail: 'not in Sent yet; waiting for the settle window' };
        return { kind: 'absent' };
      } catch (error) {
        return { kind: 'still_unknown', detail: error instanceof ProviderNetworkError ? error.message : `reconcile failed (${(error as Error).name})` };
      }
    },
  };
}
