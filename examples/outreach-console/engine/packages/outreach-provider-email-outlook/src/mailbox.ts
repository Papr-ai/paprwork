import type { AccessTokenSource, InboundMailEvent, MailboxReader, ProviderContext } from '@splitin/outreach-contracts';
import { looksLikeBounce, parseRawDsn } from '@splitin/outreach-provider-kit';
import { graphGet, graphRaw, type HttpDeps } from './graph';

export interface MailboxOptions {
  readonly http: HttpDeps;
  readonly tokens: AccessTokenSource;
  /** Messages read per poll. */
  readonly budget?: number;
  /** Re-read window before the cursor, covering messages indexed late; duplicates are dropped by event id. */
  readonly overlapMs?: number;
}

interface GraphInbound {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  internetMessageHeaders?: { name?: string; value?: string }[];
}

const SELECT = 'id,conversationId,internetMessageId,subject,receivedDateTime,bodyPreview,from,toRecipients,internetMessageHeaders';

function readCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as { t?: unknown };
    return typeof value.t === 'number' ? value.t : null;
  } catch {
    return null;
  }
}

function headersOf(message: GraphInbound): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of message.internetMessageHeaders ?? []) if (header.name && header.value !== undefined) out[header.name] = header.value;
  return out;
}

function find(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

export function outlookMailbox(options: MailboxOptions): MailboxReader {
  const { http, tokens } = options;
  const budget = options.budget ?? 200;
  const overlapMs = options.overlapMs ?? 2 * 60_000;

  const toEvent = async (ctx: ProviderContext, token: string, message: GraphInbound): Promise<InboundMailEvent> => {
    const headers = headersOf(message);
    const from = message.from?.emailAddress?.address?.toLowerCase() ?? '';
    const contentType = find(headers, 'Content-Type');
    const bounce = looksLikeBounce(from, contentType ?? '', message.subject ?? '');
    let dsn: InboundMailEvent['dsn'];
    if (bounce) {
      const raw = await graphRaw(http, ctx, token, `/me/messages/${encodeURIComponent(message.id)}/$value`);
      dsn = raw.status === 200 ? parseRawDsn(raw.text) : { status: '' };
    }
    const inReplyTo = find(headers, 'In-Reply-To')?.match(/<[^>\s]+>/)?.[0];
    return {
      eventId: `graph:${message.id}`,
      kind: bounce ? 'bounce' : 'message',
      providerMessageId: message.id,
      ...(message.conversationId ? { providerThreadId: message.conversationId } : {}),
      ...(message.internetMessageId ? { rfcMessageId: message.internetMessageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      references: find(headers, 'References')?.match(/<[^>\s]+>/g) ?? [],
      from,
      to: (message.toRecipients ?? []).flatMap((recipient) => (recipient.emailAddress?.address ? [recipient.emailAddress.address.toLowerCase()] : [])),
      ...(message.subject !== undefined ? { subject: message.subject } : {}),
      receivedAt: Date.parse(message.receivedDateTime ?? '') || ctx.now(),
      headers,
      ...(contentType ? { contentType } : {}),
      ...(dsn ? { dsn } : {}),
      ...(message.bodyPreview ? { snippet: message.bodyPreview.slice(0, 500) } : {}),
    };
  };

  return {
    async readChanges(ctx, cursorText) {
      const since = readCursor(cursorText);
      // First poll: start from now. Mail that arrived before the account was connected is not replayed.
      if (since === null) return { events: [], nextCursor: JSON.stringify({ t: ctx.now() }) };
      const token = await tokens.get(ctx);
      const events: InboundMailEvent[] = [];
      let latest = since;
      let next: string | undefined = '/me/mailFolders/inbox/messages';
      let first = true;
      while (next && events.length < budget) {
        const page = await graphGet(http, ctx, token, next, first
          ? {
              $filter: `receivedDateTime ge ${new Date(since - overlapMs).toISOString()}`,
              $orderby: 'receivedDateTime asc',
              $top: String(Math.min(50, budget)),
              $select: SELECT,
            }
          : undefined);
        first = false;
        if (page.status === 401) tokens.invalidate(ctx);
        if (page.status !== 200) throw new Error(`Graph HTTP ${page.status} reading the inbox`);
        for (const message of (page.body.value as GraphInbound[] | undefined) ?? []) {
          if (events.length >= budget) break;
          events.push(await toEvent(ctx, token, message));
          latest = Math.max(latest, Date.parse(message.receivedDateTime ?? '') || latest);
        }
        next = typeof page.body['@odata.nextLink'] === 'string' ? page.body['@odata.nextLink'] : undefined;
      }
      return { events, nextCursor: JSON.stringify({ t: latest }) };
    },
  };
}
