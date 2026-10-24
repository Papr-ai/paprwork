import type { ErrorClass, ProviderContext } from '@splitin/outreach-contracts';
import { jsonRequest, textRequest, type HttpDeps as KitHttpDeps, type JsonResponse } from '@splitin/outreach-provider-kit';

export const GRAPH_API = 'https://graph.microsoft.com';

export interface HttpDeps extends KitHttpDeps {
  readonly api: string;
}

type Query = Record<string, string | undefined>;

function url(deps: HttpDeps, path: string, query: Query = {}): URL {
  // `path` may be a full @odata.nextLink; it must stay on the configured API host.
  const target = /^https?:\/\//.test(path) ? new URL(path) : new URL(`/v1.0${path}`, deps.api);
  if (target.origin !== new URL(deps.api).origin) throw new Error(`refusing to follow a link to ${target.origin}`);
  for (const [name, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(name, value);
  return target;
}

export function graphGet(deps: HttpDeps, ctx: ProviderContext, token: string, path: string, query?: Query): Promise<JsonResponse> {
  return jsonRequest(deps, { url: url(deps, path, query), method: 'GET', token, signal: ctx.signal });
}

export function graphRaw(deps: HttpDeps, ctx: ProviderContext, token: string, path: string): Promise<{ status: number; text: string }> {
  return textRequest(deps, { url: url(deps, path), method: 'GET', token, signal: ctx.signal });
}

export function graphPost(deps: HttpDeps, ctx: ProviderContext, token: string, path: string, body?: { mime: string }): Promise<JsonResponse> {
  return jsonRequest(deps, {
    url: url(deps, path),
    method: 'POST',
    token,
    signal: ctx.signal,
    // Graph accepts a message as base64 MIME with Content-Type text/plain; that is the only way to set
    // non-X- headers such as List-Unsubscribe.
    ...(body ? { text: body.mime, contentType: 'text/plain' } : {}),
  });
}

export function graphDelete(deps: HttpDeps, ctx: ProviderContext, token: string, path: string): Promise<JsonResponse> {
  return jsonRequest(deps, { url: url(deps, path), method: 'DELETE', token, signal: ctx.signal });
}

/** Graph's error shape: {error: {code, message}}. */
function errorOf(body: Record<string, unknown>): { code: string; message: string } {
  const error = (body.error ?? {}) as { code?: unknown; message?: unknown };
  return { code: typeof error.code === 'string' ? error.code : '', message: typeof error.message === 'string' ? error.message : '' };
}

/**
 * Maps a non-2xx Graph response to the error taxonomy. `null` means the response does not prove the request
 * was refused (5xx): for a send, the outcome is unknown.
 */
export function classifyGraphError(response: JsonResponse): { errorClass: ErrorClass; retryAfterMs?: number; detail: string } | null {
  const { status } = response;
  const { code, message } = errorOf(response.body);
  const detail = `Graph HTTP ${status}${code ? ` ${code}` : ''}${message ? `: ${message.slice(0, 160)}` : ''}`;
  if (status >= 500) return null;
  if (status === 401) return { errorClass: 'auth_expired', detail };
  if (status === 429 || /QuotaExceeded|ExceededMessageLimit|SendQuota|ApplicationThrottled/i.test(code)) {
    return { errorClass: 'rate_limited', retryAfterMs: response.retryAfterMs ?? (/Quota|Limit/i.test(code) ? 3_600_000 : 60_000), detail };
  }
  if (/MessageSubmissionBlocked|AccountSuspended/i.test(code)) return { errorClass: 'policy_blocked', detail };
  if (status === 403) return { errorClass: 'forbidden', detail };
  if (/InvalidRecipients|InvalidRecipient/i.test(code)) return { errorClass: 'invalid_recipient', detail };
  return { errorClass: 'content_rejected', detail };
}
