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
import { McpOAuthProvider, McpReauthRequiredError, type McpCredentialStore } from "./McpOAuthProvider.js";
import { startLoopbackCallback } from "./mcpLoopbackCallback.js";
import {
  BUILTIN_MCP_SERVERS,
  deriveMcpServerId,
  inferMcpTransport,
  isValidMcpServerId,
  type McpServerDefinition,
} from "./mcpServerCatalog.js";
import { buildMcpAgentTool, type McpCallResult, type McpToolDescriptor } from "./mcpToolAdapter.js";

export type McpConnectionState = "disconnected" | "connecting" | "awaiting_user" | "connected" | "needs_reauth" | "error";

export interface McpServerStatus {
  id: string;
  name: string;
  url: string;
  description?: string;
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
}

// Generous: users often have to log in to the service first, then approve.
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const CALL_TIMEOUT_MS = 120_000;

export interface McpConnectionServiceOptions {
  store: McpCredentialStore;
  openBrowser?: (url: string) => Promise<void> | void;
  customServersFile?: string;
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
      custom: Boolean(def.custom),
      requiresClientId: Boolean(def.requiresClientId && !def.clientId),
      state: l?.state ?? "disconnected",
      toolCount: l?.tools.length ?? 0,
      toolNames: l?.agentToolIds ?? [],
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
  async connect(ref: string): Promise<{ status: McpServerStatus; completion: Promise<McpServerStatus> }> {
    const def = await this.resolveServer(ref);
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
        redirected!();
      }
    })();
    l.pending = run;
    run.catch(() => {});

    await Promise.race([browserOpened, run.catch(() => undefined)]);
    if ((l.state as McpConnectionState) === "error") throw new Error(l.error);
    return { status: this.statusOf(def), completion: run };
  }

  // ── ensure (non-interactive) ──────────────────────────────────────────────
  async ensure(id: string): Promise<McpServerStatus> {
    const def = await this.getServer(id);
    if (!def) throw new Error(`Unknown MCP server "${id}"`);
    const l = this.entry(id);
    if (l.client && l.state === "connected") return this.statusOf(def);
    const provider = this.makeProvider(def, false);
    if (!(await provider.hasTokens())) {
      l.state = "disconnected";
      return this.statusOf(def);
    }
    try {
      await this.attach(def, await this.openClient(def, provider));
    } catch (err) {
      const reauth = err instanceof McpReauthRequiredError || err instanceof UnauthorizedError;
      l.state = reauth ? "needs_reauth" : "error";
      l.error = reauth ? "Sign-in expired — reconnect" : err instanceof Error ? err.message : String(err);
    }
    return this.statusOf(def);
  }

  /** Reconnect every server with stored tokens. Safe to call at startup; never opens a browser. */
  async restoreAll(): Promise<void> {
    const servers = await this.listServers();
    await Promise.allSettled(servers.map((s) => this.ensure(s.id)));
  }

  // ── calls ─────────────────────────────────────────────────────────────────
  async callTool(id: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const l = this.entry(id);
    if (!l.client) {
      const s = await this.ensure(id);
      if (s.state !== "connected") throw new Error(s.state === "needs_reauth" ? new McpReauthRequiredError(id).message : `MCP server "${id}" is not connected (${s.state}). Use connect_mcp action="connect".`);
    }
    const run = () => l.client!.callTool({ name: toolName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }) as Promise<McpCallResult>;
    try {
      return await run();
    } catch (err) {
      // Session dropped (server restart, idle timeout): reconnect once.
      if (err instanceof McpReauthRequiredError || err instanceof UnauthorizedError) {
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

  async disconnect(id: string): Promise<McpServerStatus> {
    const def = await this.getServer(id);
    if (!def) throw new Error(`Unknown MCP server "${id}"`);
    const l = this.entry(id);
    await l.client?.close().catch(() => {});
    if (this.sink) for (const tid of l.agentToolIds) this.sink.unregister(tid);
    this.live.set(id, { state: "disconnected", tools: [], agentToolIds: [] });
    await this.opts.store.remove(id);
    return this.statusOf(def);
  }

  async shutdown(): Promise<void> {
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
