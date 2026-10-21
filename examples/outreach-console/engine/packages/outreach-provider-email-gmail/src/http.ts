import type { ErrorClass, ProviderContext } from '@splitin/outreach-contracts';
import { jsonRequest, type HttpDeps as KitHttpDeps, type JsonResponse } from '@splitin/outreach-provider-kit';

export const GMAIL_API = 'https://gmail.googleapis.com';

export interface HttpDeps extends KitHttpDeps {
  readonly api: string;
}

export type GmailResponse = JsonResponse;

export async function gmailRequest(
  deps: HttpDeps,
  ctx: ProviderContext,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string | readonly string[] | undefined>; json?: unknown } = {},
): Promise<GmailResponse> {
  const url = new URL(path, deps.api);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    for (const item of typeof value === 'string' ? [value] : value) url.searchParams.append(name, item);
  }
  return jsonRequest(deps, { url, method, token, signal: ctx.signal, ...(options.json === undefined ? {} : { json: options.json }) });
}

/** Google's error shape: {error: {code, message, status, errors: [{reason, message}]}}. */
function errorDetail(body: Record<string, unknown>): { reason: string; message: string } {
  const error = (body.error ?? {}) as { message?: unknown; status?: unknown; errors?: { reason?: unknown }[] };
  const reason = typeof error.errors?.[0]?.reason === 'string' ? error.errors[0].reason : typeof error.status === 'string' ? error.status : '';
  return { reason, message: typeof error.message === 'string' ? error.message : '' };
}

const RATE_REASONS = /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i;

/**
 * Maps a non-2xx Gmail response to the error taxonomy. `null` means the response does not prove the request
 * was rejected (5xx): the caller must treat the outcome as unknown.
 */
export function classifyGmailError(response: GmailResponse): { errorClass: ErrorClass; retryAfterMs?: number; detail: string } | null {
  const { status, body } = response;
  const { reason, message } = errorDetail(body);
  const detail = `Gmail HTTP ${status}${reason ? ` ${reason}` : ''}${message ? `: ${message.slice(0, 160)}` : ''}`;
  if (status >= 500) return null;
  if (status === 401) return { errorClass: 'auth_expired', detail };
  if (status === 429 || (status === 403 && RATE_REASONS.test(reason))) {
    const fallback = /daily/i.test(reason) || /daily/i.test(message) ? 3_600_000 : 60_000;
    return { errorClass: 'rate_limited', retryAfterMs: response.retryAfterMs ?? fallback, detail };
  }
  if (status === 403 && /domainPolicy/i.test(reason)) return { errorClass: 'policy_blocked', detail };
  if (status === 403) return { errorClass: 'forbidden', detail };
  if (status === 400 && /recipient|to header|invalid to|address/i.test(message)) return { errorClass: 'invalid_recipient', detail };
  return { errorClass: 'content_rejected', detail };
}
