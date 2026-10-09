/**
 * Remote MCP connections with native OAuth sign-in.
 *
 * Lifecycle per server:
 *   connect()   — interactive. Loopback listener + browser consent; the SDK
 *                 does discovery, dynamic client registration, PKCE and the
 *                 code exchange. Tokens land in the keychain.
 *   ensure()    — non-interactive (startup, tool calls). Uses stored tokens,
 *                 lets the SDK refresh; never opens a browser — a dead refresh
 *                 marks the server `needs_reauth` instead.
 *   disconnect()— closes the session and deletes stored credentials.
 *
 * Tools are pushed to a sink (the agent ToolRegistry) as `<server>__<tool>`.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { getPaprworkBaseDir } from "../../../core/utils/paprWorkspace.js";
import { McpOAuthProvider, McpReauthRequiredError, serverTokenStale, type McpCredentialStore } from "./McpOAuthProvider.js";
import type { ConnectionAudience, McpServerSignIn } from "./mcpServerSignIn.js";
import { startLoopbackCallback } from "./mcpLoopbackCallback.js";
import {
  BUILTIN_MCP_SERVERS,
  deriveMcpServerId,
  inferMcpTransport,
  isValidMcpServerId,
  type McpServerDefinition,
} from "./mcpServerCatalog.js";
import { buildMcpAgentTool, mcpAgentToolId, type McpCallResult, type McpToolDescriptor } from "./mcpToolAdapter.js";

export type McpConnectionState = "disconnected" | "connecting" | "awaiting_user" | "connected" | "needs_reauth" | "error";

export interface McpServerStatus {
  id: string;
  name: string;
  url: string;
  description?: string;
  category?: string;
  verified: boolean;
  custom: boolean;
  requiresClientId: boolean;
  state: McpConnectionState;
  toolCount: number;
  toolNames: string[];
  error?: string;
  authUrl?: string;
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AgentTool = any;
export interface McpToolSink {
  register(tool: AgentTool): void;
  unregister(toolId: string): void;
}

interface Live {
  client?: Client;
  state: McpConnectionState;
  tools: McpToolDescriptor[];
  agentToolIds: string[];
  error?: string;
  authUrl?: string;
  pending?: Promise<McpServerStatus>;
  /** Abort an in-flight interactive sign-in (frees its loopback port). */
  cancelSignIn?: () => void;
}

// Generous: users often have to log in to the service first, then approve.
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const CALL_TIMEOUT_MS = 120_000;

export interface McpConnectionServiceOptions {
  store: McpCredentialStore;
  openBrowser?: (url: string) => Promise<void> | void;
  customServersFile?: string;
  /** Pen access check, run before every tool call. Omitted in tests = allow all. */
  penGate?: import("./mcpPenGate.js").PenGate;
  /** Server sign-in (team connections, org client IDs). Omitted = loopback only. */
  serverSignIn?: McpServerSignIn;
}

export interface McpConnectOptions {
  /** Who can use the sign-in. Anything wider than "user" goes through the server. */
  audience?: ConnectionAudience;
  allowedUserIds?: string[];
  /** Force the server flow even for a personal sign-in. */
  viaServer?: boolean;
}

export function openInSystemBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error("Refusing to open non-http URL");
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
}

export class McpConnectionService {
  private readonly live = new Map<string, Live>();
  private custom: McpServerDefinition[] = [];
  private customLoaded = false;
  private sink: McpToolSink | null = null;
  private readonly openBrowser: (url: string) => Promise<void> | void;
  private readonly customFile: string;

  constructor(private readonly opts: McpConnectionServiceOptions) {
    this.openBrowser = opts.openBrowser ?? openInSystemBrowser;
    this.customFile = opts.customServersFile ?? path.join(getPaprworkBaseDir(), "mcp-servers.json");
  }

  setToolSink(sink: McpToolSink): void {
    this.sink = sink;
    for (const [id, l] of this.live) if (l.state === "connected") this.publishTools(id);
  }

  // ── server catalog ────────────────────────────────────────────────────────
  private async loadCustom(): Promise<void> {
    if (this.customLoaded) return;
    this.customLoaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.customFile, "utf8"));
      if (Array.isArray(parsed)) this.custom = parsed.filter((s) => s && isValidMcpServerId(s.id) && s.url);
    } catch {
      this.custom = [];
    }
  }

  async listServers(): Promise<McpServerDefinition[]> {
    await this.loadCustom();
    const builtinIds = new Set(BUILTIN_MCP_SERVERS.map((s) => s.id));
    return [...BUILTIN_MCP_SERVERS, ...this.custom.filter((s) => !builtinIds.has(s.id))];
  }

  async getServer(id: string): Promise<McpServerDefinition | undefined> {
    return (await this.listServers()).find((s) => s.id === id);
  }

  /** Resolve an id, a display name, or a URL to a server (registering custom URLs). */
  async resolveServer(ref: string): Promise<McpServerDefinition> {
    const r = ref.trim();
    const all = await this.listServers();
    const hit = all.find((s) => s.id === r.toLowerCase() || s.name.toLowerCase() === r.toLowerCase() || s.url === r);
    if (hit) return hit;
    if (/^https:\/\//i.test(r)) return this.addCustomServer({ url: r });
    throw new Error(`Unknown MCP server "${ref}". Known: ${all.map((s) => s.id).join(", ")}. Or pass an https:// MCP URL.`);
  }

  async addCustomServer(input: { url: string; name?: string; id?: string }): Promise<McpServerDefinition> {
    await this.loadCustom();
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("MCP server URL must be https://");
    let id = (input.id ?? deriveMcpServerId(url.toString())).toLowerCase();
    if (!isValidMcpServerId(id)) throw new Error(`Invalid server id "${id}"`);
    const all = await this.listServers();
    const existing = all.find((s) => s.url === url.toString());
    if (existing) return existing;
    for (let n = 2; all.some((s) => s.id === id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    const def: McpServerDefinition = {
      id,
      name: input.name?.trim() || url.hostname,
      url: url.toString(),
      transport: inferMcpTransport(url.toString()),
      custom: true,
    };
    this.custom.push(def);
    await this.saveCustom();
    return def;
  }

  async removeCustomServer(id: string): Promise<void> {
    await this.loadCustom();
    await this.disconnect(id).catch(() => {});
    this.custom = this.custom.filter((s) => s.id !== id);
    await this.saveCustom();
  }

  private async saveCustom(): Promise<void> {
    await fs.mkdir(path.dirname(this.customFile), { recursive: true });
    await fs.writeFile(this.customFile, JSON.stringify(this.custom, null, 2));
  }

  // ── status ────────────────────────────────────────────────────────────────
  private entry(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { state: "disconnected", tools: [], agentToolIds: [] };
      this.live.set(id, l);
    }
    return l;
  }

  private statusOf(def: McpServerDefinition): McpServerStatus {
    const l = this.live.get(def.id);
    return {
      id: def.id,
      name: def.name,
      url: def.url,
      description: def.description,
      category: def.category ?? (def.custom ? "Custom" : undefined),
      verified: Boolean(def.verified),
      custom: Boolean(def.custom),
      requiresClientId: Boolean(def.requiresClientId && !def.clientId),
      state: l?.state ?? "disconnected",
      toolCount: l?.tools.length ?? 0,
      // From the server's tool list, not the sink: status must be right even
      // when no agent registry is attached (jobs, tests, scripts).
      toolNames: (l?.tools ?? []).map((t) => mcpAgentToolId(def.id, t.name)),
      ...(l?.error ? { error: l.error } : {}),
      ...(l?.authUrl && l.state === "awaiting_user" ? { authUrl: l.authUrl } : {}),
    };
  }

  async status(id?: string): Promise<McpServerStatus[]> {
    const servers = await this.listServers();
    return servers.filter((s) => !id || s.id === id).map((s) => this.statusOf(s));
  }

  // ── transport / provider ──────────────────────────────────────────────────
  private makeProvider(def: McpServerDefinition, interactive: boolean, redirectUri?: string, state?: string) {
    return new McpOAuthProvider({
      serverId: def.id,
      store: this.opts.store,
      interactive,
      redirectUri,
      state,
      staticClientId: def.clientId,
      openBrowser: this.openBrowser,
    });
  }

  private makeTransport(def: McpServerDefinition, provider: McpOAuthProvider): Transport & { finishAuth(code: string): Promise<void> } {
    const url = new URL(def.url);
    return def.transport === "sse"
      ? new SSEClientTransport(url, { authProvider: provider })
      : new StreamableHTTPClientTransport(url, { authProvider: provider });
  }

  private async openClient(def: McpServerDefinition, provider: McpOAuthProvider): Promise<Client> {
    const client = new Client({ name: "papr-work", version: "2" }, { capabilities: {} });
    await client.connect(this.makeTransport(def, provider));
    return client;
  }

  private async attach(def: McpServerDefinition, client: Client): Promise<void> {
    const l = this.entry(def.id);
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as McpToolDescriptor[]));
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    await l.client?.close().catch(() => {});
    l.client = client;
    l.tools = tools;
    l.state = "connected";
    l.error = undefined;
    l.authUrl = undefined;
    client.onclose = () => {
      if (l.client === client) l.client = undefined;
    };
    this.publishTools(def.id, def.name);
  }

  private publishTools(id: string, name?: string): void {
    const l = this.live.get(id);
    if (!l || !this.sink) return;
    for (const tid of l.agentToolIds) this.sink.unregister(tid);
    const server = { id, name: name ?? id };
    l.agentToolIds = l.tools.map((t) => {
      const tool = buildMcpAgentTool(server, t, (sid, tn, args) => this.callTool(sid, tn, args));
      this.sink!.register(tool);
      return tool.id as string;
    });
  }

  // ── connect (interactive) ─────────────────────────────────────────────────
  /**
   * Start sign-in. Resolves when the browser consent page has been opened (or
   * the stored tokens were enough). `completion` resolves when fully connected.
   */
  async connect(ref: string, opts: McpConnectOptions = {}): Promise<{ status: McpServerStatus; completion: Promise<McpServerStatus> }> {
    const def = await this.resolveServer(ref);
    const ss = this.opts.serverSignIn;
    const wide = Boolean(opts.audience && opts.audience !== "user");
    const needsOrgClient = Boolean(def.requiresClientId && !def.clientId);
    if (ss && (wide || opts.viaServer || (needsOrgClient && (await ss.hasClientId(def))))) {
      return this.connectViaServer(def, ss, opts);
    }
    if (wide) throw new Error("Sharing a sign-in needs Papr cloud. Sign in to Papr and try again.");
    if (def.requiresClientId && !def.clientId) {
      throw new Error(`${def.name}'s MCP server does not support dynamic client registration yet — it needs a registered Papr Work OAuth client id.`);
    }
    const l = this.entry(def.id);
    if (l.pending) return { status: this.statusOf(def), completion: l.pending };

    // Stored tokens may already work — no browser needed.
    try {
      const status = await this.ensure(def.id);
      if (status.state === "connected") return { status, completion: Promise.resolve(status) };
    } catch {
      /* fall through to interactive */
    }

    l.state = "connecting";
    l.error = undefined;
    const state = randomBytes(16).toString("hex");
    const cb = await startLoopbackCallback({ expectedState: state, serviceName: def.name, timeoutMs: SIGN_IN_TIMEOUT_MS });
    l.cancelSignIn = () => cb.close();
    const provider = this.makeProvider(def, true, cb.redirectUri, state);
    const transport = this.makeTransport(def, provider);
    const client = new Client({ name: "papr-work", version: "2" }, { capabilities: {} });

    let redirected: () => void;
    const browserOpened = new Promise<void>((r) => (redirected = r));

    const run = (async (): Promise<McpServerStatus> => {
      try {
        try {
          await client.connect(transport);
          // Authorized without a redirect (e.g. refresh succeeded).
          await this.attach(def, client);
          return this.statusOf(def);
        } catch (err) {
          if (!(err instanceof UnauthorizedError) || !provider.authorizationUrl) throw err;
        }
        l.state = "awaiting_user";
        l.authUrl = provider.authorizationUrl.toString();
        redirected!();
        const code = await cb.waitForCode;
        await transport.finishAuth(code);
        await transport.close().catch(() => {});
        await this.attach(def, await this.openClient(def, this.makeProvider(def, false)));
        return this.statusOf(def);
      } catch (err) {
        l.state = "error";
        l.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        cb.close();
        l.pending = undefined;
        l.cancelSignIn = undefined;
        redirected!();
      }
    })();
    l.pending = run;
    run.catch(() => {});

    await Promise.race([browserOpened, run.catch(() => undefined)]);
    if ((l.state as McpConnectionState) === "error") throw new Error(l.error);
    return { status: this.statusOf(def), completion: run };
  }

  /** Sign in through apps.papr.ai/oauth/callback; the server keeps the refresh token. */
  private async connectViaServer(
    def: McpServerDefinition,
    ss: McpServerSignIn,
    opts: McpConnectOptions,
  ): Promise<{ status: McpServerStatus; completion: Promise<McpServerStatus> }> {
    const l = this.entry(def.id);
    if (l.pending) return { status: this.statusOf(def), completion: l.pending };
    l.state = "connecting";
    l.error = undefined;
    let started: { sessionId: string; authorizeUrl: string };
    try {
      started = await ss.start(def, { audience: opts.audience ?? "user", allowedUserIds: opts.allowedUserIds });
      await this.openBrowser(started.authorizeUrl);
    } catch (err) {
      l.state = "error";
      l.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    l.state = "awaiting_user";
    l.authUrl = started.authorizeUrl;
    const abort = new AbortController();
    l.cancelSignIn = () => abort.abort();
    const run = (async (): Promise<McpServerStatus> => {
      try {
        await ss.wait(started.sessionId, abort.signal);
        await this.pickUpServerCredential(def.id, true);
        await this.attach(def, await this.openClient(def, this.makeProvider(def, false)));
        return this.statusOf(def);
      } catch (err) {
        l.state = abort.signal.aborted ? "disconnected" : "error";
        l.error = abort.signal.aborted ? undefined : err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        l.pending = undefined;
        l.cancelSignIn = undefined;
      }
    })();
    l.pending = run;
    run.catch(() => {});
    return { status: this.statusOf(def), completion: run };
  }

  /**
   * Fetch a fresh server-managed credential into the keychain. Returns false when
   * the server has no connection this user may use.
   */
  private async pickUpServerCredential(id: string, force = false): Promise<boolean> {
    const ss = this.opts.serverSignIn;
    if (!ss) return false;
    const rejected = force ? (await this.opts.store.load(id))?.tokens?.access_token : undefined;
    const cred = await ss.claim(id, force, rejected);
    if (!cred?.tokens?.access_token) return false;
    await this.opts.store.save(id, cred);
    return true;
  }

  // ── ensure (non-interactive) ──────────────────────────────────────────────
  async ensure(id: string): Promise<McpServerStatus> {
    const def = await this.getServer(id);
    if (!def) throw new Error(`Unknown MCP server "${id}"`);
    const l = this.entry(id);
    if (l.client && l.state === "connected") return this.statusOf(def);
    const stored = await this.opts.store.load(id);
    if (stored?.serverRefresh && serverTokenStale(stored)) {
      try {
        if (!(await this.pickUpServerCredential(id))) {
          l.state = "disconnected";
          return this.statusOf(def);
        }
      } catch (err) {
        const reauth = (err as { status?: number }).status === 401;
        l.state = reauth ? "needs_reauth" : "error";
        l.error = reauth ? "Sign-in expired — reconnect" : err instanceof Error ? err.message : String(err);
        return this.statusOf(def);
      }
    }
    const provider = this.makeProvider(def, false);
    if (!(await provider.hasTokens())) {
      l.state = "disconnected";
      return this.statusOf(def);
    }
    try {
      await this.attach(def, await this.openClient(def, provider));
    } catch (err) {
      // Server-managed token rejected early (revoked/rotated): claim once and retry.
      if (stored?.serverRefresh && (err instanceof McpReauthRequiredError || err instanceof UnauthorizedError)) {
        try {
          if (await this.pickUpServerCredential(id, true)) {
            await this.attach(def, await this.openClient(def, this.makeProvider(def, false)));
            return this.statusOf(def);
          }
        } catch {
          /* fall through to needs_reauth */
        }
      }
      const reauth = err instanceof McpReauthRequiredError || err instanceof UnauthorizedError;
      l.state = reauth ? "needs_reauth" : "error";
      l.error = reauth ? "Sign-in expired — reconnect" : err instanceof Error ? err.message : String(err);
    }
    return this.statusOf(def);
  }

  /** Reconnect every server with stored tokens. Safe to call at startup; never opens a browser. */
  async restoreAll(): Promise<void> {
    const servers = await this.listServers();
    await this.pickUpSharedConnections(servers).catch((err) => console.warn("[MCP] server connections:", err));
    await Promise.allSettled(servers.map((s) => this.ensure(s.id)));
  }

  /** Team connections someone else set up (server-managed) that this Mac doesn't have yet. */
  async pickUpSharedConnections(servers?: McpServerDefinition[]): Promise<string[]> {
    const ss = this.opts.serverSignIn;
    if (!ss) return [];
    const known = new Set((servers ?? (await this.listServers())).map((s) => s.id));
    const picked: string[] = [];
    for (const c of await ss.list()) {
      if (!known.has(c.serverId) || c.status !== "ok") continue;
      if ((await this.opts.store.load(c.serverId))?.tokens?.access_token) continue;
      if (await this.pickUpServerCredential(c.serverId).catch(() => false)) picked.push(c.serverId);
    }
    return picked;
  }

  // ── calls ─────────────────────────────────────────────────────────────────
  /** Tool names, descriptions and input schemas for a connected server. */
  async listTools(id: string): Promise<McpToolDescriptor[]> {
    const s = await this.ensure(id);
    if (s.state !== "connected") return [];
    return (this.live.get(id)?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
  }

  async callTool(id: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const l = this.entry(id);
    if (!l.client) {
      const s = await this.ensure(id);
      if (s.state !== "connected") throw new Error(s.state === "needs_reauth" ? new McpReauthRequiredError(id).message : `MCP server "${id}" is not connected (${s.state}). Use connect_mcp action="connect".`);
    }
    const annotations = l.tools.find((t) => t.name === toolName)?.annotations;
    await this.opts.penGate?.(id, toolName, annotations);
    const run = () => l.client!.callTool({ name: toolName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }) as Promise<McpCallResult>;
    try {
      return await run();
    } catch (err) {
      // Session dropped (server restart, idle timeout): reconnect once.
      if (err instanceof McpReauthRequiredError || err instanceof UnauthorizedError) {
        if ((await this.opts.store.load(id))?.serverRefresh && (await this.pickUpServerCredential(id, true).catch(() => false))) {
          l.client = undefined;
          const s = await this.ensure(id);
          if (s.state === "connected") return run();
        }
        l.state = "needs_reauth";
        throw new McpReauthRequiredError(id);
      }
      l.client = undefined;
      l.state = "disconnected";
      const s = await this.ensure(id);
      if (s.state !== "connected") throw err;
      return run();
    }
  }

  /** Abandon an in-flight sign-in (user closed the browser tab, clicked Cancel). */
  async cancelSignIn(id: string): Promise<McpServerStatus> {
    const def = await this.getServer(id);
    if (!def) throw new Error(`Unknown MCP server "${id}"`);
    const l = this.entry(id);
    l.cancelSignIn?.();
    if (l.pending) await l.pending.catch(() => {});
    if (l.state !== "connected") {
      l.state = "disconnected";
      l.error = undefined;
      l.authUrl = undefined;
    }
    return this.statusOf(def);
  }

  async disconnect(id: string): Promise<McpServerStatus> {
    const def = await this.getServer(id);
    if (!def) throw new Error(`Unknown MCP server "${id}"`);
    const l = this.entry(id);
    l.cancelSignIn?.();
    await l.client?.close().catch(() => {});
    if (this.sink) for (const tid of l.agentToolIds) this.sink.unregister(tid);
    this.live.set(id, { state: "disconnected", tools: [], agentToolIds: [] });
    await this.opts.store.remove(id);
    return this.statusOf(def);
  }

  async shutdown(): Promise<void> {
    for (const l of this.live.values()) l.cancelSignIn?.();
    await Promise.allSettled([...this.live.values()].map((l) => l.client?.close()));
  }
}

let instance: McpConnectionService | null = null;

export function getMcpConnectionService(): McpConnectionService | null {
  return instance;
}

export function initializeMcpConnectionService(opts: McpConnectionServiceOptions): McpConnectionService {
  instance ??= new McpConnectionService(opts);
  return instance;
}
