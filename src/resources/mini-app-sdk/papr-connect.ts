/**
 * Connections for mini-apps — use the user's Linear, HubSpot, Stripe, Notion…
 * through one-click OAuth (remote MCP servers). No API keys in the app.
 *
 *   import { papr } from '/__papr__/papr-connect.js';
 *
 *   const s = await papr.connect.status(['hubspot']);        // { hubspot: 'connected' | 'disconnected' | … }
 *   await papr.connect.connect('hubspot');                    // browser consent; resolves when connected
 *   const r = await papr.connect.call('hubspot', 'search_contacts', { query: 'acme' });
 *   papr.connect.button(el, 'hubspot', { onConnected: load }); // ready-made Connect button
 *
 * Declare every service the app uses in apps/<id>/connections.json:
 *   { "connections": ["hubspot", "linear"] }
 * Undeclared services are refused, and the user approves each app × service
 * once before the first call. Tokens never reach the app.
 */

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "awaiting_user"
  | "connected"
  | "needs_reauth"
  | "error"
  | "unavailable";

export interface ConnectionInfo {
  id: string;
  name: string;
  state: ConnectionState;
  toolCount: number;
  authUrl?: string;
}

export interface CallResult {
  /** Tool output flattened to text (JSON for most servers — try JSON.parse). */
  text: string;
  structuredContent: unknown;
  isError: boolean;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class ConnectError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

const POLL_MS = 1_500;
const CONNECT_TIMEOUT_MS = 15 * 60_000;

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ConnectError(json.error || `Request failed (${res.status})`, res.status);
  return json as T;
}

const sid = (id: string) => encodeURIComponent(id.trim().toLowerCase());

async function list(): Promise<ConnectionInfo[]> {
  const { servers } = await request<{ servers: ConnectionInfo[] }>("/api/mcp/servers");
  return servers;
}

/** State of each requested service (all declared services when omitted). */
async function status(ids?: string[]): Promise<Record<string, ConnectionState>> {
  const servers = await list();
  const out: Record<string, ConnectionState> = {};
  for (const s of servers) out[s.id] = s.state;
  for (const id of ids ?? []) out[id] ??= "unavailable";
  if (!ids) return out;
  return Object.fromEntries(ids.map((id) => [id, out[id]]));
}

async function info(id: string): Promise<ConnectionInfo | undefined> {
  return (await list()).find((s) => s.id === id.trim().toLowerCase());
}

/**
 * Start sign-in (first use asks the user to allow this app) and resolve once
 * the service is connected. Rejects if the user cancels or it times out.
 */
async function connect(id: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ConnectionInfo> {
  const { server } = await request<{ server: ConnectionInfo }>(`/api/mcp/servers/${sid(id)}/connect`, {
    method: "POST",
    body: {},
  });
  if (server.state === "connected") return server;
  const deadline = Date.now() + (opts?.timeoutMs ?? CONNECT_TIMEOUT_MS);
  for (;;) {
    if (opts?.signal?.aborted) {
      await cancel(id).catch(() => {});
      throw new ConnectError("Sign-in cancelled", 499);
    }
    if (Date.now() > deadline) throw new ConnectError("Timed out waiting for sign-in", 408);
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await info(id);
    if (!s) throw new ConnectError(`"${id}" is not declared in connections.json`, 403);
    if (s.state === "connected") return s;
    if (s.state === "error" || s.state === "disconnected") {
      throw new ConnectError(`${s.name} sign-in did not finish`, 400);
    }
  }
}

async function cancel(id: string): Promise<void> {
  await request(`/api/mcp/servers/${sid(id)}/cancel`, { method: "POST", body: {} });
}

/** Call one tool on a connected service. */
async function call(id: string, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return request<CallResult>("/api/mcp/call", {
    method: "POST",
    body: { server: id.trim().toLowerCase(), tool, arguments: args },
  });
}

/** call() + JSON.parse of the text, falling back to the raw text. */
async function callJson<T = unknown>(id: string, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(id, tool, args);
  if (r.isError) throw new ConnectError(r.text || "Tool returned an error", 502);
  if (r.structuredContent != null) return r.structuredContent as T;
  try {
    return JSON.parse(r.text) as T;
  } catch {
    return r.text as unknown as T;
  }
}

/** Tool names + input schemas — useful while building, not needed at runtime. */
async function tools(id: string): Promise<ToolInfo[]> {
  const r = await request<{ tools: ToolInfo[] }>(`/api/mcp/servers/${sid(id)}/tools`);
  return r.tools;
}

export interface ButtonOptions {
  onConnected?: (info: ConnectionInfo) => void;
  /** Button text when disconnected. Default: "Connect <Name>". */
  label?: string;
}

/**
 * Render a Connect button into `el` that tracks the service's state.
 * Returns a cleanup function. Styling: `.papr-connect-btn[data-state]`.
 */
function button(el: HTMLElement, id: string, opts: ButtonOptions = {}): () => void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "papr-connect-btn";
  el.replaceChildren(btn);
  let disposed = false;
  let busy = false;

  const paint = (s: ConnectionInfo | undefined) => {
    const state: ConnectionState = s?.state ?? "unavailable";
    const name = s?.name ?? id;
    btn.dataset.state = state;
    btn.disabled = busy || state === "connected" || state === "unavailable";
    btn.textContent =
      state === "connected" ? `${name} connected`
      : state === "awaiting_user" || state === "connecting" || busy ? `Approve in your browser…`
      : state === "needs_reauth" ? `Reconnect ${name}`
      : state === "unavailable" ? `${name} unavailable`
      : (opts.label ?? `Connect ${name}`);
  };

  const refresh = async () => {
    try {
      const s = await info(id);
      if (!disposed) paint(s);
      return s;
    } catch {
      if (!disposed) paint(undefined);
      return undefined;
    }
  };

  btn.addEventListener("click", async () => {
    busy = true;
    paint(await info(id).catch(() => undefined));
    try {
      const s = await connect(id);
      busy = false;
      if (!disposed) {
        paint(s);
        opts.onConnected?.(s);
      }
    } catch {
      busy = false;
      if (!disposed) await refresh();
    }
  });

  void refresh().then((s) => {
    if (s?.state === "connected") opts.onConnected?.(s);
  });
  return () => {
    disposed = true;
    btn.remove();
  };
}

export const papr = {
  connect: { status, info, connect, cancel, call, callJson, tools, button },
};

export default papr;
