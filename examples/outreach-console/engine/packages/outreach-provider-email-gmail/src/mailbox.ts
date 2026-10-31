import type { AccessTokenSource, InboundMailEvent, MailboxReader, ProviderContext } from '@splitin/outreach-contracts';
import { decodeHtmlEntities, looksLikeBounce as looksLikeBounceKit, parseDeliveryStatus } from '@splitin/outreach-provider-kit';
import { gmailRequest, type HttpDeps } from './http';

export interface MailboxOptions {
  readonly http: HttpDeps;
  readonly tokens: AccessTokenSource;
  /** Messages fetched per poll; the cursor resumes after the last processed history record. */
  readonly budget?: number;
}

const USERS_ME = '/gmail/v1/users/me';
const METADATA = [
  'From', 'To', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'Content-Type', 'Auto-Submitted',
  'Precedence', 'X-Autoreply', 'X-Autorespond', 'X-Failed-Recipients', 'List-Id',
];
const ADDRESS = /[^\s<>,;:"()]+@[^\s<>,;:"()]+/g;

interface Part {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string };
  parts?: Part[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

/** Cursor: the last history record processed. JSON so the format can grow. */
interface Cursor {
  readonly h: string;
}

function readCursor(cursor: string | null): Cursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<Cursor>;
    return typeof value.h === 'string' ? { h: value.h } : null;
  } catch {
    return null;
  }
}

const write = (h: string): string => JSON.stringify({ h });

function headersOf(part: Part | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of part?.headers ?? []) if (header.name && header.value !== undefined) out[header.name] = header.value;
  return out;
}

function find(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function walk(part: Part | undefined, visit: (part: Part) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function looksLikeBounce(headers: Record<string, string>): boolean {
  return looksLikeBounceKit(find(headers, 'From') ?? '', find(headers, 'Content-Type') ?? '');
}

/**
 * Status, recipient and original Message-ID from the message/delivery-status part. Without that part the
 * status stays empty, so the classifier sends the message to review instead of suppressing anyone.
 */
function parseDsn(message: GmailMessage): InboundMailEvent['dsn'] {
  let status = '';
  let recipient: string | undefined;
  let originalMessageId: string | undefined;
  walk(message.payload, (part) => {
    const type = part.mimeType?.toLowerCase();
    if (type === 'message/delivery-status') {
      const parsed = parseDeliveryStatus(decode(part.body?.data));
      status ||= parsed.status;
      recipient ??= parsed.recipient;
    }
    if (type === 'text/rfc822-headers' || type === 'message/rfc822') {
      const text = decode(part.body?.data);
      originalMessageId = /^Message-ID:\s*(<[^>\s]+>)/im.exec(text)?.[1] ?? find(headersOf(part), 'Message-ID') ?? originalMessageId;
      for (const child of part.parts ?? []) originalMessageId ??= find(headersOf(child), 'Message-ID');
    }
  });
  return { status, ...(recipient ? { recipient } : {}), ...(originalMessageId ? { originalMessageId } : {}) };
}

export function gmailMailbox(options: MailboxOptions): MailboxReader {
  const { http, tokens } = options;
  const budget = options.budget ?? 200;

  const get = async (ctx: ProviderContext, token: string, path: string, query: Record<string, string | string[] | undefined>) => {
    const response = await gmailRequest(http, ctx, token, 'GET', path, { query });
    if (response.status === 401) tokens.invalidate(ctx);
    return response;
  };

  const toEvent = async (ctx: ProviderContext, token: string, id: string): Promise<InboundMailEvent | null> => {
    const meta = await get(ctx, token, `${USERS_ME}/messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: METADATA });
    if (meta.status === 404) return null; // Deleted since it arrived.
    if (meta.status !== 200) throw new Error(`Gmail HTTP ${meta.status} reading message`);
    let message = meta.body as unknown as GmailMessage;
    if ((message.labelIds ?? []).some((label) => label === 'SENT' || label === 'DRAFT')) return null;
    const headers = headersOf(message.payload);
    const bounce = looksLikeBounce(headers);
    if (bounce) {
      const full = await get(ctx, token, `${USERS_ME}/messages/${encodeURIComponent(id)}`, { format: 'full' });
      if (full.status === 200) message = full.body as unknown as GmailMessage;
    }
    const rfcMessageId = find(headers, 'Message-ID');
    const inReplyTo = find(headers, 'In-Reply-To')?.match(/<[^>\s]+>/)?.[0];
    const contentType = find(headers, 'Content-Type');
    const subject = find(headers, 'Subject');
    return {
      eventId: `gmail:${message.id}`,
      kind: bounce ? 'bounce' : 'message',
      providerMessageId: message.id,
      ...(message.threadId ? { providerThreadId: message.threadId } : {}),
      ...(rfcMessageId ? { rfcMessageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      references: find(headers, 'References')?.match(/<[^>\s]+>/g) ?? [],
      from: (find(headers, 'From')?.match(ADDRESS)?.[0] ?? '').toLowerCase(),
      to: (find(headers, 'To')?.match(ADDRESS) ?? []).map((address) => address.toLowerCase()),
      ...(subject !== undefined ? { subject } : {}),
      receivedAt: Number(message.internalDate) || ctx.now(),
      headers,
      ...(contentType ? { contentType } : {}),
      ...(bounce ? { dsn: parseDsn(message) } : {}),
      ...(message.snippet ? { snippet: decodeHtmlEntities(message.snippet).slice(0, 500) } : {}),
    };
  };

  return {
    async readChanges(ctx, cursorText) {
      const token = await tokens.get(ctx);
      const cursor = readCursor(cursorText);
      if (!cursor) {
        // First poll: start from now. Mail that arrived before the account was connected is not replayed.
        const profile = await get(ctx, token, `${USERS_ME}/profile`, {});
        if (profile.status !== 200 || typeof profile.body.historyId !== 'string') throw new Error(`Gmail HTTP ${profile.status} reading profile`);
        return { events: [], nextCursor: write(profile.body.historyId) };
      }

      const events: InboundMailEvent[] = [];
      let fetched = 0;
      let last = cursor.h;
      let pageToken: string | undefined;
      do {
        const page = await get(ctx, token, `${USERS_ME}/history`, { startHistoryId: cursor.h, historyTypes: 'messageAdded', pageToken });
        if (page.status === 404) return recover(ctx, token);
        if (page.status !== 200) throw new Error(`Gmail HTTP ${page.status} reading history`);
        const records = (page.body.history as { id: string; messagesAdded?: { message: GmailMessage }[] }[] | undefined) ?? [];
        for (const record of records) {
          const added = record.messagesAdded ?? [];
          if (fetched > 0 && fetched + added.length > budget) return { events, nextCursor: write(last) };
          for (const { message } of added) {
            if ((message.labelIds ?? []).some((label) => label === 'SENT' || label === 'DRAFT')) continue;
            fetched += 1;
            const event = await toEvent(ctx, token, message.id);
            if (event) events.push(event);
          }
          last = record.id;
        }
        pageToken = typeof page.body.nextPageToken === 'string' ? page.body.nextPageToken : undefined;
        if (!pageToken && typeof page.body.historyId === 'string') last = page.body.historyId;
      } while (pageToken);
      return { events, nextCursor: write(last) };
    },
  };

  /**
   * The history cursor expired (Gmail keeps about a week). Re-read recent inbox mail instead; events are
   * deduplicated by `eventId`, so overlap with earlier polls is harmless.
   */
  async function recover(ctx: ProviderContext, token: string) {
    const profile = await get(ctx, token, `${USERS_ME}/profile`, {});
    if (profile.status !== 200 || typeof profile.body.historyId !== 'string') throw new Error(`Gmail HTTP ${profile.status} reading profile`);
    const listed = await get(ctx, token, `${USERS_ME}/messages`, { labelIds: 'INBOX', maxResults: String(Math.min(budget, 100)) });
    if (listed.status !== 200) throw new Error(`Gmail HTTP ${listed.status} listing inbox`);
    const events: InboundMailEvent[] = [];
    for (const item of (listed.body.messages as { id: string }[] | undefined) ?? []) {
      const event = await toEvent(ctx, token, item.id);
      if (event) events.push(event);
    }
    return { events, nextCursor: write(profile.body.historyId) };
  }
}
