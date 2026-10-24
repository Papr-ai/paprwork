import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeSendMode } from './fake-email';

/**
 * A local HTTP server speaking the subset of Microsoft Graph and the Microsoft identity platform that the
 * Outlook adapter uses: MIME drafts, send (which moves the message to Sent Items under a new id), OData
 * filters and paging, raw MIME, and the authorization-code and refresh-token grants with rotation.
 */
export interface FakeGraphOptions {
  readonly mailbox?: string;
  readonly tenant?: string;
  readonly clientId?: string;
  /** Emulate Exchange assigning its own Message-ID. */
  readonly replaceMessageId?: boolean;
  /** Issue a new refresh token on every refresh, as Microsoft does. */
  readonly rotateRefreshTokens?: boolean;
  readonly pageSize?: number;
}

interface Header {
  name: string;
  value: string;
}

export interface FakeGraphMessage {
  id: string;
  folder: 'drafts' | 'sentitems' | 'inbox';
  internetMessageId: string;
  conversationId: string;
  subject: string;
  from: string;
  to: string[];
  at: string;
  bodyPreview: string;
  headers: Header[];
  mime: string;
}

function parseHeaders(mime: string): Header[] {
  const block = (mime.split(/\r?\n\r?\n/)[0] ?? '').replace(/\r?\n[ \t]+/g, ' ');
  return block.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf(':');
    return index > 0 ? [{ name: line.slice(0, index), value: line.slice(index + 1).trim() }] : [];
  });
}

const header = (headers: Header[], name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const addresses = (value: string) => (value.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? []).map((a) => a.toLowerCase());

export class FakeGraphServer {
  readonly messages: FakeGraphMessage[] = [];
  readonly issuedTokens = new Set<string>();
  readonly validRefreshTokens = new Set<string>(['ms-refresh-1']);
  sendCalls = 0;
  private counter = 0;
  private forced: FakeSendMode[] = [];
  private readonly codes = new Map<string, { challenge: string; redirectUri: string }>();
  private server: Server | undefined;
  url = '';

  constructor(readonly options: FakeGraphOptions = {}) {}

  get mailbox(): string {
    return this.options.mailbox ?? 'sam@contoso.example';
  }

  get tenant(): string {
    return this.options.tenant ?? 'contoso.example';
  }

  grant(refreshToken = 'ms-refresh-1'): string {
    return JSON.stringify({ tenant: this.tenant, clientId: this.options.clientId ?? 'ms-client', refreshToken });
  }

  force(mode: FakeSendMode): void {
    this.forced.push(mode);
  }

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

  /** Delivers an inbound message to the Inbox. */
  deliver(input: { mime: string; bodyPreview?: string; conversationId?: string; at?: number }): FakeGraphMessage {
    const headers = parseHeaders(input.mime);
    return this.store('inbox', headers, input.mime, input.conversationId, input.bodyPreview ?? '', input.at);
  }

  private store(folder: FakeGraphMessage['folder'], headers: Header[], mime: string, conversationId: string | undefined, bodyPreview: string, at?: number): FakeGraphMessage {
    this.counter += 1;
    const id = `AAMk${this.counter.toString().padStart(6, '0')}`;
    const message: FakeGraphMessage = {
      id,
      folder,
      internetMessageId: header(headers, 'Message-ID') || `<gen-${this.counter}@contoso.example>`,
      conversationId: conversationId ?? `conv-${this.counter}`,
      subject: header(headers, 'Subject'),
      from: addresses(header(headers, 'From'))[0] ?? '',
      to: addresses(header(headers, 'To')),
      at: new Date(at ?? Date.now()).toISOString(),
      bodyPreview,
      headers,
      mime,
    };
    this.messages.push(message);
    return message;
  }

  private json(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private error(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
    this.json(res, status, { error: { code, message } }, headers);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const identity = /^\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/.exec(url.pathname);
    if (identity) {
      if (decodeURIComponent(identity[1] ?? '') !== this.tenant) return this.json(res, 400, { error: 'invalid_tenant' });
      return identity[2] === 'authorize' ? this.authorize(res, url.searchParams) : this.token(res, new URLSearchParams(text));
    }
    if (!this.issuedTokens.has(req.headers.authorization?.replace(/^Bearer /, '') ?? '')) {
      return this.error(res, 401, 'InvalidAuthenticationToken', 'Access token has expired or is not yet valid.');
    }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    if (req.method === 'GET' && path === '/me') return this.json(res, 200, { mail: this.mailbox, userPrincipalName: this.mailbox });
    if (req.method === 'POST' && path === '/me/messages') return this.createDraft(res, text);
    const send = /^\/me\/messages\/([^/]+)\/send$/.exec(path);
    if (req.method === 'POST' && send) return this.send(req, res, decodeURIComponent(send[1] ?? ''));
    const raw = /^\/me\/messages\/([^/]+)\/\$value$/.exec(path);
    if (req.method === 'GET' && raw) {
      const message = this.messages.find((m) => m.id === decodeURIComponent(raw[1] ?? ''));
      if (!message) return this.error(res, 404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
      res.writeHead(200, { 'content-type': 'text/plain' });
      return void res.end(message.mime);
    }
    const one = /^\/me\/messages\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && one) {
      const index = this.messages.findIndex((m) => m.id === decodeURIComponent(one[1] ?? ''));
      if (index >= 0) this.messages.splice(index, 1);
      return this.json(res, 204);
    }
    const folder = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(path);
    if (req.method === 'GET' && folder) return this.list(res, (folder[1] ?? '').toLowerCase(), url.searchParams);
    return this.error(res, 404, 'ResourceNotFound', 'Resource not found');
  }

  private authorize(res: ServerResponse, params: URLSearchParams): void {
    const redirectUri = params.get('redirect_uri') ?? '';
    if (!/^http:\/\/localhost:\d+\/$/.test(redirectUri) || params.get('code_challenge_method') !== 'S256') return this.json(res, 400, { error: 'invalid_request' });
    const code = `ms-code-${this.codes.size + 1}`;
    this.codes.set(code, { challenge: params.get('code_challenge') ?? '', redirectUri });
    // Point the browser at the IPv4 loopback so tests do not depend on how `localhost` resolves.
    const callback = redirectUri.replace('://localhost:', '://127.0.0.1:');
    res.writeHead(302, { location: `${callback}?code=${code}&state=${encodeURIComponent(params.get('state') ?? '')}` });
    res.end();
  }

  private token(res: ServerResponse, form: URLSearchParams): void {
    if (form.get('client_id') !== (this.options.clientId ?? 'ms-client')) return this.json(res, 400, { error: 'invalid_client' });
    let refresh = form.get('refresh_token') ?? '';
    if (form.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant' });
      refresh = 'ms-refresh-1';
    } else if (!this.validRefreshTokens.has(refresh)) {
      return this.json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70000: The provided grant is invalid.' });
    }
    if (this.options.rotateRefreshTokens) {
      refresh = `ms-refresh-${this.validRefreshTokens.size + 1}`;
      this.validRefreshTokens.add(refresh);
    }
    const token = `eyJ.fake-${this.issuedTokens.size + 1}`;
    this.issuedTokens.add(token);
    this.json(res, 200, { access_token: token, refresh_token: refresh, expires_in: 3599, scope: 'Mail.ReadWrite Mail.Send User.Read' });
  }

  private createDraft(res: ServerResponse, base64: string): void {
    const mime = Buffer.from(base64, 'base64').toString('utf8');
    const headers = parseHeaders(mime);
    if (!header(headers, 'To')) return this.error(res, 400, 'ErrorInvalidRecipients', 'At least one recipient is not valid.');
    if (this.options.replaceMessageId) {
      const index = headers.findIndex((h) => h.name.toLowerCase() === 'message-id');
      if (index >= 0) headers.splice(index, 1);
    }
    const draft = this.store('drafts', headers, mime, undefined, '');
    this.json(res, 201, { id: draft.id, internetMessageId: draft.internetMessageId, conversationId: draft.conversationId, isDraft: true });
  }

  private send(req: IncomingMessage, res: ServerResponse, id: string): void {
    this.sendCalls += 1;
    const draft = this.messages.find((m) => m.id === id && m.folder === 'drafts');
    if (!draft) return this.error(res, 404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    const mode = this.forced.shift() ?? { kind: 'accept' as const };
    if (mode.kind === 'unknown_before_accept') return void req.socket.destroy();
    if (mode.kind === 'reject') {
      if (mode.errorClass === 'rate_limited') return this.error(res, 429, 'ApplicationThrottled', 'Too many requests', { 'retry-after': String(Math.round((mode.retryAfterMs ?? 60_000) / 1000)) });
      if (mode.errorClass === 'invalid_recipient') return this.error(res, 400, 'ErrorInvalidRecipients', 'At least one recipient is not valid.');
      if (mode.errorClass === 'policy_blocked') return this.error(res, 403, 'ErrorMessageSubmissionBlocked', 'Your account has been blocked from sending mail.');
      if (mode.errorClass === 'transient') return this.error(res, 503, 'ServiceUnavailable', 'Service unavailable');
      return this.error(res, 400, 'ErrorInvalidRequest', 'Invalid request');
    }
    // Exchange deletes the draft and stores a copy in Sent Items under a new id.
    this.messages.splice(this.messages.indexOf(draft), 1);
    this.counter += 1;
    this.messages.push({ ...draft, id: `AAMk-sent-${this.counter}`, folder: 'sentitems', at: new Date().toISOString() });
    if (mode.kind === 'unknown_after_accept') return void req.socket.destroy();
    this.json(res, 202);
  }

  private list(res: ServerResponse, folder: string, params: URLSearchParams): void {
    let rows = this.messages.filter((m) => m.folder === folder);
    const filter = params.get('$filter') ?? '';
    const byId = /^internetMessageId eq '(.*)'$/.exec(filter);
    if (byId) rows = rows.filter((m) => m.internetMessageId === (byId[1] ?? '').replace(/''/g, "'"));
    const since = /^receivedDateTime ge (\S+)$/.exec(filter);
    if (since) rows = rows.filter((m) => m.at >= (since[1] ?? ''));
    const order = params.get('$orderby') ?? '';
    rows = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (/desc$/.test(order)) rows.reverse();
    const top = Number(params.get('$top') ?? this.options.pageSize ?? 10);
    const skip = Number(params.get('$skip') ?? 0);
    const page = rows.slice(skip, skip + top);
    const next = new URL(`${this.url}/v1.0/me/mailFolders/${folder}/messages`);
    for (const [key, value] of params) if (key !== '$skip') next.searchParams.set(key, value);
    next.searchParams.set('$skip', String(skip + top));
    this.json(res, 200, {
      value: page.map((m) => ({
        id: m.id,
        internetMessageId: m.internetMessageId,
        conversationId: m.conversationId,
        subject: m.subject,
        bodyPreview: m.bodyPreview,
        sentDateTime: m.at,
        receivedDateTime: m.at,
        from: { emailAddress: { address: m.from } },
        toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
        internetMessageHeaders: m.headers,
      })),
      ...(skip + top < rows.length ? { '@odata.nextLink': next.toString() } : {}),
    });
  }
}
