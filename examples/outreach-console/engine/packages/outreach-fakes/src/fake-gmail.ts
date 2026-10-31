import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeSendMode } from './fake-email';

/**
 * A local HTTP server speaking the subset of the Gmail API and Google's token endpoint that the Gmail
 * adapter uses. Tests drive the real adapter over real HTTP, including dropped connections.
 */
export interface FakeGmailOptions {
  readonly mailbox?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly refreshToken?: string;
  /** Emulate Gmail assigning its own Message-ID to sent mail. */
  readonly replaceMessageId?: boolean;
  /** Emulate a search index that has not caught up: `rfc822msgid:` queries find nothing. */
  readonly searchLag?: boolean;
  /** History records per page. */
  readonly historyPageSize?: number;
}

interface Header {
  name: string;
  value: string;
}

export interface FakeGmailPart {
  mimeType: string;
  headers?: Header[];
  body?: { data?: string };
  parts?: FakeGmailPart[];
}

export interface FakeGmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  headers: Header[];
  payload?: FakeGmailPart;
  raw?: string;
}

function parseHeaders(mime: string): Header[] {
  const block = mime.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf(':');
    return index > 0 ? [{ name: line.slice(0, index), value: line.slice(index + 1).trim() }] : [];
  });
}

export class FakeGmailServer {
  readonly messages: FakeGmailMessage[] = [];
  readonly history: { id: string; messagesAdded: { message: { id: string; threadId: string; labelIds: string[] } }[] }[] = [];
  /** Oldest history id still available; older cursors get 404 like an expired Gmail cursor. */
  oldestHistoryId = 0;
  readonly issuedTokens = new Set<string>();
  sendCalls = 0;
  /** Scopes the fake consent screen grants; defaults to whatever was requested. */
  grantedScopes: string[] | undefined;
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>();
  private historyId = 1000;
  private counter = 0;
  private forced: FakeSendMode[] = [];
  private server: Server | undefined;
  url = '';

  constructor(readonly options: FakeGmailOptions = {}) {}

  get mailbox(): string {
    return this.options.mailbox ?? 'sender@example.com';
  }

  /** Secret JSON to store behind the account's secretRef. */
  grant(overrides: { refreshToken?: string } = {}): string {
    return JSON.stringify({
      clientId: this.options.clientId ?? 'client-id',
      clientSecret: this.options.clientSecret ?? 'client-secret-value',
      refreshToken: overrides.refreshToken ?? this.options.refreshToken ?? 'refresh-token-value',
    });
  }

  force(mode: FakeSendMode): void {
    this.forced.push(mode);
  }

  /** Invalidates every issued access token, as if Google rotated them. */
  expireTokens(): void {
    this.issuedTokens.clear();
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  /** Delivers an inbound message (a reply, a bounce, ...) and records it in history. */
  deliver(input: { headers: Record<string, string>; snippet?: string; labelIds?: string[]; threadId?: string; payload?: FakeGmailPart; at?: number }): FakeGmailMessage {
    const headers = Object.entries(input.headers).map(([name, value]) => ({ name, value }));
    const message = this.store(headers, input.labelIds ?? ['INBOX', 'UNREAD'], input.threadId, input.snippet ?? '', input.at);
    if (input.payload) message.payload = input.payload;
    return message;
  }

  private store(headers: Header[], labelIds: string[], threadId: string | undefined, snippet: string, at?: number): FakeGmailMessage {
    this.counter += 1;
    const id = `gm${this.counter.toString(16).padStart(8, '0')}`;
    const message: FakeGmailMessage = { id, threadId: threadId ?? id, labelIds, snippet, internalDate: String(at ?? Date.now()), headers };
    this.messages.push(message);
    this.historyId += 7;
    this.history.push({ id: String(this.historyId), messagesAdded: [{ message: { id, threadId: message.threadId, labelIds } }] });
    return message;
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private error(res: ServerResponse, status: number, message: string, reason = '', headers: Record<string, string> = {}): void {
    this.json(res, status, { error: { code: status, message, ...(reason ? { errors: [{ reason, message }] } : {}) } }, headers);
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const text = await this.body(req);
    if (req.method === 'GET' && url.pathname === '/authorize') return this.authorize(res, url.searchParams);
    if (req.method === 'POST' && url.pathname === '/token') return this.token(res, new URLSearchParams(text));
    const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!this.issuedTokens.has(auth)) return this.error(res, 401, 'Request had invalid authentication credentials.');
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, '');
    if (req.method === 'POST' && path === '/messages/send') return this.send(req, res, JSON.parse(text) as { raw: string; threadId?: string });
    if (req.method === 'GET' && path === '/profile') return this.json(res, 200, { emailAddress: this.mailbox, historyId: String(this.historyId) });
    if (req.method === 'GET' && path === '/messages') return this.list(res, url.searchParams);
    if (req.method === 'GET' && path.startsWith('/messages/')) return this.get(res, decodeURIComponent(path.slice('/messages/'.length)), url.searchParams);
    if (req.method === 'GET' && path === '/history') return this.historyList(res, url.searchParams);
    return this.error(res, 404, 'Not found');
  }

  /** The consent screen: approves at once and redirects to the loopback callback with a code. */
  private authorize(res: ServerResponse, params: URLSearchParams): void {
    const redirectUri = params.get('redirect_uri') ?? '';
    if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri) || params.get('code_challenge_method') !== 'S256') {
      return this.error(res, 400, 'invalid_request');
    }
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, { challenge: params.get('code_challenge') ?? '', redirectUri, scope: this.grantedScopes?.join(' ') ?? params.get('scope') ?? '' });
    res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(params.get('state') ?? '')}` });
    res.end();
  }

  private token(res: ServerResponse, form: URLSearchParams): void {
    const expected = JSON.parse(this.grant()) as { clientId: string; clientSecret: string; refreshToken: string };
    if (form.get('client_id') !== expected.clientId || form.get('client_secret') !== expected.clientSecret) {
      return this.json(res, 401, { error: 'invalid_client' });
    }
    if (form.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant' });
      const token = `ya29.fake-${this.issuedTokens.size + 1}`;
      this.issuedTokens.add(token);
      return this.json(res, 200, { access_token: token, refresh_token: expected.refreshToken, scope: pending.scope, expires_in: 3599 });
    }
    if (form.get('refresh_token') !== expected.refreshToken) return this.json(res, 400, { error: 'invalid_grant' });
    const token = `ya29.fake-${this.issuedTokens.size + 1}-${Math.random().toString(36).slice(2)}`;
    this.issuedTokens.add(token);
    this.json(res, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
  }

  private send(req: IncomingMessage, res: ServerResponse, body: { raw: string; threadId?: string }): void {
    this.sendCalls += 1;
    const mode = this.forced.shift() ?? { kind: 'accept' as const };
    if (mode.kind === 'unknown_before_accept') {
      req.socket.destroy();
      return;
    }
    if (mode.kind === 'reject') {
      if (mode.errorClass === 'rate_limited') {
        return this.error(res, 429, 'User-rate limit exceeded.', 'userRateLimitExceeded', { 'retry-after': String(Math.round((mode.retryAfterMs ?? 60_000) / 1000)) });
      }
      if (mode.errorClass === 'invalid_recipient') return this.error(res, 400, 'Invalid To header', 'invalidArgument');
      if (mode.errorClass === 'policy_blocked') return this.error(res, 403, 'Delegation denied by domain policy', 'domainPolicy');
      if (mode.errorClass === 'transient') return this.error(res, 503, 'Backend Error', 'backendError');
      return this.error(res, 400, 'Invalid argument', 'invalidArgument');
    }
    if (body.threadId && !this.messages.some((message) => message.threadId === body.threadId)) {
      return this.error(res, 404, 'Requested entity was not found.', 'notFound');
    }
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    const headers = parseHeaders(mime);
    if (this.options.replaceMessageId) {
      const index = headers.findIndex((header) => header.name.toLowerCase() === 'message-id');
      const replaced = { name: 'Message-ID', value: `<CAF${this.counter + 1}.gmail@mail.gmail.com>` };
      if (index >= 0) headers[index] = replaced;
      else headers.push(replaced);
    }
    const message = this.store(headers, ['SENT'], body.threadId, '');
    message.raw = mime;
    if (mode.kind === 'unknown_after_accept') {
      req.socket.destroy();
      return;
    }
    this.json(res, 200, { id: message.id, threadId: message.threadId, labelIds: message.labelIds });
  }

  private visible(message: FakeGmailMessage, includeSpamTrash: boolean): boolean {
    return includeSpamTrash || !message.labelIds.some((label) => label === 'SPAM' || label === 'TRASH');
  }

  private list(res: ServerResponse, params: URLSearchParams): void {
    const includeSpamTrash = params.get('includeSpamTrash') === 'true';
    const labels = params.getAll('labelIds');
    const q = params.get('q') ?? '';
    let matches = [...this.messages].reverse().filter((message) => this.visible(message, includeSpamTrash));
    if (labels.length) matches = matches.filter((message) => labels.every((label) => message.labelIds.includes(label)));
    const msgid = /rfc822msgid:(\S+)/.exec(q)?.[1];
    if (msgid !== undefined) {
      matches = this.options.searchLag
        ? []
        : matches.filter((message) => message.headers.some((h) => h.name.toLowerCase() === 'message-id' && h.value.replace(/^<|>$/g, '') === msgid));
    }
    const size = Number(params.get('maxResults') ?? 100);
    const start = Number(params.get('pageToken') ?? 0);
    const page = matches.slice(start, start + size);
    const next = start + size < matches.length ? String(start + size) : undefined;
    this.json(res, 200, {
      ...(page.length ? { messages: page.map((message) => ({ id: message.id, threadId: message.threadId })) } : {}),
      ...(next ? { nextPageToken: next } : {}),
      resultSizeEstimate: matches.length,
    });
  }

  private get(res: ServerResponse, id: string, params: URLSearchParams): void {
    const message = this.messages.find((candidate) => candidate.id === id);
    if (!message) return this.error(res, 404, 'Requested entity was not found.', 'notFound');
    const wanted = params.getAll('metadataHeaders').map((name) => name.toLowerCase());
    const headers = params.get('format') === 'metadata' && wanted.length
      ? message.headers.filter((header) => wanted.includes(header.name.toLowerCase()))
      : message.headers;
    const payload = params.get('format') === 'full' && message.payload ? { ...message.payload, headers } : { mimeType: 'text/plain', headers };
    this.json(res, 200, { id: message.id, threadId: message.threadId, labelIds: message.labelIds, snippet: message.snippet, internalDate: message.internalDate, payload });
  }

  private historyList(res: ServerResponse, params: URLSearchParams): void {
    const start = Number(params.get('startHistoryId'));
    if (!Number.isFinite(start) || start < this.oldestHistoryId) return this.error(res, 404, 'Requested entity was not found.', 'notFound');
    const records = this.history.filter((record) => Number(record.id) > start);
    const size = this.options.historyPageSize ?? 100;
    const offset = Number(params.get('pageToken') ?? 0);
    const page = records.slice(offset, offset + size);
    const next = offset + size < records.length ? String(offset + size) : undefined;
    this.json(res, 200, { ...(page.length ? { history: page } : {}), historyId: String(this.historyId), ...(next ? { nextPageToken: next } : {}) });
  }
}
