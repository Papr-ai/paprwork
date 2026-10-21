import {
  buildMime,
  IDEMPOTENCY_HEADER,
  MimeError,
  TokenError,
  type AccessTokenSource,
  type ApprovedEmail,
  type EmailSender,
  type ProviderContext,
  type ReconcileResult,
  type SendResult,
  type UncertainEmail,
} from '@splitin/outreach-contracts';
import { ProviderNetworkError } from '@splitin/outreach-provider-kit';
import { classifyGraphError, graphDelete, graphGet, graphPost, type HttpDeps } from './graph';

export interface SenderOptions {
  readonly http: HttpDeps;
  readonly tokens: AccessTokenSource;
  /** How long after an attempt Sent Items must lack the message before reconciliation may answer "absent". */
  readonly settleMs: number;
  readonly scanWindowMs?: number;
  readonly scanLimit?: number;
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  sentDateTime?: string;
  internetMessageHeaders?: { name?: string; value?: string }[];
}

function tokenFailure(error: unknown): { errorClass: TokenError['errorClass']; detail: string } {
  if (error instanceof TokenError) return { errorClass: error.errorClass, detail: error.message };
  return { errorClass: 'transient', detail: `token unavailable (${(error as Error).name})` };
}

const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function outlookSender(options: SenderOptions): EmailSender {
  const { http, tokens } = options;
  const scanWindowMs = options.scanWindowMs ?? 15 * 60_000;
  const scanLimit = options.scanLimit ?? 200;

  const discardDraft = async (ctx: ProviderContext, token: string, id: string) => {
    await graphDelete(http, ctx, token, `/me/messages/${encodeURIComponent(id)}`).catch(() => {});
  };

  return {
    /**
     * Draft, then send. Creating a draft never sends anything, so every failure before the send call is a
     * safe transient rejection; only the send call itself can leave the outcome unknown.
     */
    async send(ctx, email: ApprovedEmail): Promise<SendResult> {
      let mime: string;
      try {
        mime = Buffer.from(buildMime(email, new Date(ctx.now())), 'utf8').toString('base64');
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

      let draft: GraphMessage;
      try {
        const created = await graphPost(http, ctx, token, '/me/messages', { mime });
        if (created.status !== 201 || typeof created.body.id !== 'string') {
          if (created.status === 401) tokens.invalidate(ctx);
          const rejected = classifyGraphError(created);
          return { kind: 'rejected', ...(rejected ?? { errorClass: 'transient', detail: `Graph HTTP ${created.status} creating the draft` }) };
        }
        draft = created.body as unknown as GraphMessage;
      } catch (error) {
        return { kind: 'rejected', errorClass: 'transient', detail: `draft not created (${(error as Error).message})` };
      }

      let sent;
      try {
        sent = await graphPost(http, ctx, token, `/me/messages/${encodeURIComponent(draft.id)}/send`);
      } catch (error) {
        if (error instanceof ProviderNetworkError && !error.reachedServer) {
          await discardDraft(ctx, token, draft.id);
          return { kind: 'rejected', errorClass: 'transient', detail: error.message };
        }
        return { kind: 'unknown', detail: error instanceof ProviderNetworkError ? error.message : `send failed (${(error as Error).name})` };
      }
      if (sent.status === 202 || sent.status === 200) {
        return {
          kind: 'accepted',
          receipt: {
            // Exchange gives the Sent Items copy a new item id, so the stable identifier is internetMessageId.
            providerMessageId: draft.internetMessageId ?? draft.id,
            ...(draft.conversationId ? { providerThreadId: draft.conversationId } : {}),
            ...(draft.internetMessageId ? { rfcMessageId: draft.internetMessageId } : {}),
            acceptedAt: ctx.now(),
            raw: { graphDraftId: draft.id },
          },
        };
      }
      if (sent.status === 401) tokens.invalidate(ctx);
      const rejected = classifyGraphError(sent);
      if (!rejected) return { kind: 'unknown', detail: `Graph HTTP ${sent.status} on send` };
      await discardDraft(ctx, token, draft.id);
      return { kind: 'rejected', ...rejected };
    },

    async reconcile(ctx, email: UncertainEmail): Promise<ReconcileResult> {
      let token: string;
      try {
        token = await tokens.get(ctx);
      } catch (error) {
        return { kind: 'still_unknown', detail: tokenFailure(error).detail };
      }
      const select = 'id,internetMessageId,conversationId,sentDateTime,internetMessageHeaders';
      const found = (message: GraphMessage): ReconcileResult => ({
        kind: 'found',
        receipt: {
          providerMessageId: message.internetMessageId ?? message.id,
          ...(message.conversationId ? { providerThreadId: message.conversationId } : {}),
          ...(message.internetMessageId ? { rfcMessageId: message.internetMessageId } : {}),
          acceptedAt: Date.parse(message.sentDateTime ?? '') || ctx.now(),
          raw: { graphId: message.id, via: 'reconcile' },
        },
      });
      const matches = (message: GraphMessage) =>
        message.internetMessageId === email.rfcMessageId ||
        (message.internetMessageHeaders ?? []).some((h) => h.name?.toLowerCase() === IDEMPOTENCY_HEADER.toLowerCase() && h.value === email.idempotencyKey);
      try {
        // Fast path: our Message-ID, when Exchange kept it.
        const direct = await graphGet(http, ctx, token, '/me/mailFolders/sentitems/messages', {
          $filter: `internetMessageId eq ${odataString(email.rfcMessageId)}`,
          $select: select,
        });
        if (direct.status === 401) {
          tokens.invalidate(ctx);
          return { kind: 'still_unknown', detail: 'access token rejected; retrying with a fresh one next time' };
        }
        const hit = ((direct.body.value as GraphMessage[] | undefined) ?? []).find(matches);
        if (hit) return found(hit);

        // Authoritative path: Sent Items newest first, matched on our idempotency header.
        let next: string | undefined = '/me/mailFolders/sentitems/messages';
        let first = true;
        let inspected = 0;
        let reachedOlder = false;
        while (next) {
          const page = await graphGet(http, ctx, token, next, first ? { $orderby: 'sentDateTime desc', $top: '50', $select: select } : undefined);
          first = false;
          if (page.status !== 200) return { kind: 'still_unknown', detail: `Sent Items scan failed with HTTP ${page.status}` };
          for (const message of (page.body.value as GraphMessage[] | undefined) ?? []) {
            inspected += 1;
            if (matches(message)) return found(message);
            if (Date.parse(message.sentDateTime ?? '') < email.attemptedAt - scanWindowMs) {
              reachedOlder = true;
              next = undefined;
              break;
            }
            if (inspected >= scanLimit) {
              next = undefined;
              break;
            }
          }
          if (next !== undefined) {
            next = typeof page.body['@odata.nextLink'] === 'string' ? page.body['@odata.nextLink'] : undefined;
            if (!next) reachedOlder = true; // All of Sent Items was inspected.
          }
        }
        if (!reachedOlder) return { kind: 'still_unknown', detail: `Sent Items not fully scanned (${inspected} messages inspected)` };
        if (ctx.now() - email.attemptedAt < options.settleMs) return { kind: 'still_unknown', detail: 'not in Sent Items yet; waiting for the settle window' };
        // Never sent: remove the orphaned draft so nobody sends it by hand later (the engine's retry makes a new one).
        const drafts = await graphGet(http, ctx, token, '/me/mailFolders/drafts/messages', { $top: '50', $select: 'id,internetMessageId,internetMessageHeaders' });
        for (const draft of (drafts.body.value as GraphMessage[] | undefined) ?? []) {
          if (matches(draft)) await discardDraft(ctx, token, draft.id);
        }
        return { kind: 'absent' };
      } catch (error) {
        return { kind: 'still_unknown', detail: error instanceof ProviderNetworkError ? error.message : `reconcile failed (${(error as Error).name})` };
      }
    },
  };
}
