/**
 * papr_api: the tunnel that lets a card in Claude make the same /api calls a published
 * app makes on apps.papr.ai — without any app code change.
 *
 * Card:   fetch('/api/db/query', {...})  →  tools/call papr_api {namespaceId, slug, method, path, body}
 * Here:   dispatch over loopback to this same Cloud App Host process, as the signed-in user.
 *
 * Going through the real HTTP handlers (not private methods) means the tunnel inherits
 * every existing check — per-app access, read-only SQL guard, rate limits, row caps,
 * per-user isolation — with zero duplication. Cost is one localhost hop (~1ms).
 */
import type { McpCaller } from "./auth.js";

export type TunnelMethod = "GET" | "POST";

export interface TunnelRequest {
  namespaceId: string;
  slug: string;
  method: TunnelMethod;
  path: string;
  body?: unknown;
}

export interface TunnelResponse {
  status: number;
  body: unknown;
}

/**
 * What a card may reach. Mirrors the Cloud App Host /api surface apps already use.
 * Deliberately excludes /api/bash/run and /api/credentials/*.
 */
const ALLOWED: Array<[TunnelMethod, RegExp]> = [
  ["GET", /^\/api\/access$/],
  ["GET", /^\/api\/members$/],
  ["GET", /^\/api\/db\/schema$/],
  ["POST", /^\/api\/db\/(query|batch|query-batch|read-batch|write|write-batch)$/],
  ["POST", /^\/api\/app\/backend\/[A-Za-z0-9_-]{1,64}$/],
  ["GET", /^\/api\/jobs\/list$/],
  ["GET", /^\/api\/jobs\/status\/[A-Za-z0-9_-]{1,64}$/],
  ["POST", /^\/api\/jobs\/run$/],
  ["GET", /^\/api\/files$/],
  ["POST", /^\/api\/files\/url$/],
];

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 30_000;

export class TunnelError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function assertTunnelAllowed(req: TunnelRequest): void {
  if (!SLUG.test(req.namespaceId) || !SLUG.test(req.slug)) {
    throw new TunnelError("Invalid app reference");
  }
  const [pathname, query = ""] = req.path.split("?", 2);
  if (pathname.includes("..") || pathname.includes("//")) throw new TunnelError("Invalid path");
  if (!ALLOWED.some(([m, re]) => m === req.method && re.test(pathname))) {
    throw new TunnelError(`${req.method} ${pathname} is not available to cards`, 403);
  }
  if (query.length > 2048) throw new TunnelError("Query too long");
  if (req.method === "GET" && req.body !== undefined) throw new TunnelError("GET has no body");
}

export async function dispatchTunnel(
  port: number,
  caller: McpCaller,
  req: TunnelRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TunnelResponse> {
  assertTunnelAllowed(req);
  const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
  if (payload && Buffer.byteLength(payload) > MAX_BODY_BYTES) throw new TunnelError("Body too large", 413);

  const res = await fetchImpl(`http://127.0.0.1:${port}${req.path}`, {
    method: req.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-session-token": caller.sessionToken,
      "x-papr-external-user-id": caller.userId,
      "x-papr-namespace-id": req.namespaceId,
      "x-papr-slug": req.slug,
      "x-papr-via": "mcp",
    },
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response (rare): pass text through */
  }
  return { status: res.status, body };
}

const VIEW = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Reads a published card (dist/cards/{view}.html) through the host's normal app-file
 * route, as the caller, so the same per-app access rules decide who can load it.
 */
export async function fetchPublishedCard(
  port: number,
  caller: McpCaller,
  ref: { namespaceId: string; slug: string },
  view: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!SLUG.test(ref.namespaceId) || !SLUG.test(ref.slug) || !VIEW.test(view)) {
    throw new TunnelError("Invalid card reference");
  }
  const res = await fetchImpl(
    `http://127.0.0.1:${port}/${ref.namespaceId}/${ref.slug}/dist/cards/${view}.html`,
    {
      headers: {
        accept: "text/html",
        "x-session-token": caller.sessionToken,
        "x-papr-external-user-id": caller.userId,
        "x-papr-via": "mcp",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new TunnelError(`Card unavailable (HTTP ${res.status})`, res.status);
  return res.text();
}
