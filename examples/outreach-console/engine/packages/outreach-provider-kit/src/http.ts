export interface HttpDeps {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
}

export interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfterMs?: number;
}

/**
 * The request failed without an HTTP response. `reachedServer` is false only when the connection was never
 * established, which proves the provider did nothing; every other failure may have been processed.
 */
export class ProviderNetworkError extends Error {
  constructor(
    readonly reachedServer: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderNetworkError';
  }
}

const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function failureCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : '';
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export interface JsonRequest {
  readonly url: URL | string;
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  readonly token?: string;
  readonly signal: AbortSignal;
  /** Serialized as JSON. */
  readonly json?: unknown;
  /** Sent as-is with `contentType` (e.g. base64 MIME for Microsoft Graph). */
  readonly text?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * One HTTP call whose response body is returned as text (raw MIME, Slack's plain "ok"). A body cut short
 * after the status line still counts as a response: the outcome is known from the status.
 */
export async function textRequest(deps: HttpDeps, request: JsonRequest): Promise<{ status: number; text: string; retryAfterMs?: number }> {
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  if (request.token) headers.authorization = `Bearer ${request.token}`;
  let body: string | undefined;
  if (request.json !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(request.json);
  } else if (request.text !== undefined) {
    headers['content-type'] = request.contentType ?? 'text/plain';
    body = request.text;
  }
  let response: Response;
  try {
    response = await deps.fetch(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.any([request.signal, AbortSignal.timeout(deps.timeoutMs)]) });
  } catch (error) {
    const code = failureCode(error);
    throw new ProviderNetworkError(!CONNECT_FAILURES.has(code), `request failed (${code || (error as Error).name})`);
  }
  const text = await response.text().catch(() => '');
  const wait = parseRetryAfter(response.headers.get('retry-after'));
  return { status: response.status, text, ...(wait === undefined ? {} : { retryAfterMs: wait }) };
}

/** One HTTP call with a JSON (or empty) response; network failures carry whether the server was reached. */
export async function jsonRequest(deps: HttpDeps, request: JsonRequest): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  if (request.token) headers.authorization = `Bearer ${request.token}`;
  let body: string | undefined;
  if (request.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(request.json);
  } else if (request.text !== undefined) {
    headers['content-type'] = request.contentType ?? 'text/plain';
    body = request.text;
  }
  let response: Response;
  try {
    response = await deps.fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(deps.timeoutMs)]),
    });
  } catch (error) {
    const code = failureCode(error);
    throw new ProviderNetworkError(!CONNECT_FAILURES.has(code), `request failed (${code || (error as Error).name})`);
  }
  let parsed: Record<string, unknown> = {};
  try {
    const text = await response.text();
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (error) {
    // The status line arrived, so the outcome is known even if the body was cut short.
    if (response.ok) throw new ProviderNetworkError(true, `response body unreadable (${(error as Error).name})`);
  }
  const wait = parseRetryAfter(response.headers.get('retry-after'));
  return { status: response.status, body: parsed, ...(wait === undefined ? {} : { retryAfterMs: wait }) };
}
