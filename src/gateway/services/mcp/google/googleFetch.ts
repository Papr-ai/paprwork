/**
 * Authenticated calls to Google's public REST APIs (Gmail v1, Drive v3) for the
 * built-in Google connectors. Tokens come from the server-managed credential
 * (memory server keeps the refresh token); on 401 we ask for a fresh one once.
 */

/** Returns a usable access token. `force` = the last one was rejected. */
export type GoogleTokenSource = (force?: boolean) => Promise<string>;

export class GoogleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
  }
}

const TIMEOUT_MS = 60_000;

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    if (msg) return `Google API ${res.status}: ${msg}`;
  } catch {
    /* not JSON */
  }
  return `Google API ${res.status}: ${text.slice(0, 300) || res.statusText}`;
}

export async function googleFetch(token: GoogleTokenSource, url: string, init: RequestInit = {}): Promise<Response> {
  const send = async (force: boolean) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await token(force)}`);
    return fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  if (!res.ok) throw new GoogleApiError(res.status, await errorMessage(res));
  return res;
}

export async function googleJson<T>(token: GoogleTokenSource, url: string, init: RequestInit = {}): Promise<T> {
  const res = await googleFetch(token, url, init);
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | string[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** MCP tool result helpers. */
export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const json = (v: unknown) => text(JSON.stringify(v, null, 2));
export async function safe(fn: () => Promise<{ content: Array<{ type: "text"; text: string }> }>) {
  try {
    return await fn();
  } catch (err) {
    return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
  }
}
