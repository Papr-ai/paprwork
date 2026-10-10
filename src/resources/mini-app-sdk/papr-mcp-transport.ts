/**
 * Makes an unchanged Papr app run inside a Claude card.
 *
 * On apps.papr.ai an app calls fetch('/api/db/query'), fetch('/api/app/backend/x'),
 * new EventSource('/api/jobs/events'). Inside Claude there is no Papr origin, so this
 * module reroutes exactly those calls through the hidden `papr_api` MCP tool:
 *
 *   fetch('/api/…')                 → tools/call papr_api {namespaceId, slug, method, path, body}
 *   EventSource('/api/jobs/events') → polls /api/jobs/status/:id via papr_api, emits
 *                                     the same "jobs:status-changed" events
 *
 * Everything else (CDN fetches, data: URLs) goes to the real fetch untouched.
 */

import type { ToolResult } from "./papr-mcp-bridge.ts";

export interface AppRef {
  namespaceId: string;
  slug: string;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface McpTransportOptions {
  callTool: CallTool;
  /** May be a promise: cards install the transport before the tool result names the app. */
  ref: AppRef | Promise<AppRef>;
  win?: typeof globalThis;
  /** Job status poll interval for the EventSource shim. */
  pollMs?: number;
}

export const PAPR_API_TOOL = "papr_api";

/** Returns "/api/…?q" for app API URLs, else null. */
export function apiPathOf(input: string, base = "http://card.invalid/"): string | null {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  const sameOrigin = url.origin === new URL(base).origin;
  if (!sameOrigin || !url.pathname.startsWith("/api/")) return null;
  return url.pathname + url.search;
}

function parseBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") throw new TypeError("Papr cards send JSON bodies only");
  try {
    return JSON.parse(body);
  } catch {
    throw new TypeError("Papr cards send JSON bodies only");
  }
}

export async function tunnelRequest(
  callTool: CallTool,
  refOrPromise: AppRef | Promise<AppRef>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "POST") throw new TypeError(`${m} is not available in Papr cards`);
  const ref = await refOrPromise;
  const r = await callTool(PAPR_API_TOOL, { namespaceId: ref.namespaceId, slug: ref.slug, method: m, path, ...(body === undefined ? {} : { body }) });
  const sc = r.structuredContent as { status?: number; body?: unknown } | undefined;
  if (sc && typeof sc.status === "number") return { status: sc.status, body: sc.body };
  // Tool-level failure with no HTTP shape (e.g. validation): surface as 502.
  return { status: 502, body: { error: r.content?.[0]?.text ?? "Papr request failed" } };
}

export function createTunnelFetch(opts: McpTransportOptions, realFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = apiPathOf(href, opts.win?.location?.href);
    if (!path) return realFetch(input, init);
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const out = await tunnelRequest(opts.callTool, opts.ref, method, path, parseBody(init?.body));
    const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? null);
    return new Response(text, {
      status: out.status,
      headers: { "content-type": typeof out.body === "string" ? "text/plain" : "application/json" },
    });
  };
}

type Listener = (ev: MessageEvent) => void;

/** Drop-in for EventSource('/api/jobs/events?jobIds=…'): status changes by polling. */
export class PollingJobEvents {
  readonly url: string;
  readyState = 1;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private last = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string, private readonly opts: McpTransportOptions) {
    this.url = url;
    const jobIds = (new URL(url, "http://card.invalid/").searchParams.get("jobIds") ?? "")
      .split(",")
      .filter(Boolean);
    if (jobIds.length === 0) return;
    const tick = (): void => void this.poll(jobIds);
    this.timer = setInterval(tick, opts.pollMs ?? 3000);
    tick();
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.readyState = 2;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      try {
        const r = await tunnelRequest(this.opts.callTool, this.opts.ref, "GET", `/api/jobs/status/${encodeURIComponent(jobId)}`);
        if (r.status >= 400 || !r.body || typeof r.body !== "object") continue;
        const job = r.body as { status?: string; name?: string; completedAt?: string; error?: string; lastOutput?: string };
        if (!job.status || this.last.get(jobId) === job.status) continue;
        const first = !this.last.has(jobId);
        this.last.set(jobId, job.status);
        if (first) continue; // baseline, like SSE: only report changes
        this.emit("jobs:status-changed", { jobId, ...job });
      } catch (err) {
        this.onerror?.(new Event("error"));
        void err;
      }
    }
  }

  private emit(type: string, data: unknown): void {
    const ev = { type, data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

/**
 * Patch fetch + EventSource on `win`. Idempotent per window. Returns an uninstaller.
 * Must run before app code so module-level fetches are covered.
 */
export function installMcpTransport(opts: McpTransportOptions): () => void {
  const win = (opts.win ?? globalThis) as typeof globalThis & { __paprMcpTransport?: boolean };
  if (win.__paprMcpTransport) return () => {};
  const realFetch = win.fetch.bind(win);
  const RealEventSource = win.EventSource;
  win.fetch = createTunnelFetch({ ...opts, win }, realFetch);
  const Shim = function (this: unknown, url: string | URL, init?: EventSourceInit) {
    const href = String(url);
    const path = apiPathOf(href, win.location?.href);
    if (path?.startsWith("/api/jobs/events")) return new PollingJobEvents(path, opts);
    if (!RealEventSource) throw new Error("EventSource unavailable");
    return new RealEventSource(url, init);
  } as unknown as typeof EventSource;
  win.EventSource = Shim;
  win.__paprMcpTransport = true;
  return () => {
    win.fetch = realFetch;
    win.EventSource = RealEventSource;
    win.__paprMcpTransport = false;
  };
}
