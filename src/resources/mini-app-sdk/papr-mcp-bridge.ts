/**
 * Minimal MCP Apps client (SEP-1865, protocol 2026-01-26) for Papr cards.
 *
 * Why not @modelcontextprotocol/ext-apps `App`: it pulls the full MCP SDK + zod
 * (~330–430 KB) into every card. Cards need six messages, so this speaks them
 * directly (~3 KB). Conformance is pinned by tests against ext-apps' AppBridge.
 *
 * Messages used:
 *   → ui/initialize, ui/notifications/initialized, tools/call, ui/open-link,
 *     ui/update-model-context, ui/notifications/size-changed
 *   ← ui/notifications/tool-input, ui/notifications/tool-result,
 *     ui/notifications/host-context-changed, ui/resource-teardown, ping
 */

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
}

/** Wire abstraction so the bridge runs in an iframe (postMessage) or in tests. */
export interface BridgePort {
  post(message: RpcMessage): void;
  listen(handler: (message: RpcMessage) => void): () => void;
}

export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Json;
  isError?: boolean;
  _meta?: Json;
}

export interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined> };
  displayMode?: string;
  locale?: string;
  [key: string]: unknown;
}

export function windowPort(win: Window = window): BridgePort {
  return {
    post: (message) => win.parent.postMessage(message, "*"),
    listen: (handler) => {
      const onMessage = (ev: MessageEvent): void => {
        if (ev.source !== win.parent) return;
        const data = ev.data as RpcMessage | undefined;
        if (data && data.jsonrpc === "2.0") handler(data);
      };
      win.addEventListener("message", onMessage);
      return () => win.removeEventListener("message", onMessage);
    },
  };
}

export class McpHostBridge {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  private unlisten: (() => void) | null = null;
  hostContext: HostContext = {};
  onToolInput?: (args: Json) => void;
  onToolResult?: (result: ToolResult) => void;
  onHostContext?: (ctx: HostContext) => void;
  onTeardown?: () => void;

  constructor(
    private readonly port: BridgePort,
    private readonly appInfo = { name: "papr-card", version: "1.0.0" },
  ) {}

  async connect(): Promise<HostContext> {
    this.unlisten = this.port.listen((m) => this.receive(m));
    const result = await this.request("ui/initialize", {
      appInfo: this.appInfo,
      appCapabilities: {},
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    });
    this.hostContext = (result.hostContext as HostContext) ?? {};
    this.notify("ui/notifications/initialized", {});
    return this.hostContext;
  }

  close(): void {
    this.unlisten?.();
    this.unlisten = null;
    for (const p of this.pending.values()) p.reject(new Error("Bridge closed"));
    this.pending.clear();
  }

  callTool(name: string, args: Json): Promise<ToolResult> {
    return this.request("tools/call", { name, arguments: args }) as Promise<ToolResult>;
  }

  async openLink(url: string): Promise<void> {
    const r = await this.request("ui/open-link", { url });
    if (r.isError) throw new Error("Host refused to open the link");
  }

  async updateModelContext(text: string, structuredContent?: Json): Promise<void> {
    await this.request("ui/update-model-context", {
      content: [{ type: "text", text }],
      ...(structuredContent ? { structuredContent } : {}),
    });
  }

  reportSize(width: number, height: number): void {
    this.notify("ui/notifications/size-changed", { width: Math.ceil(width), height: Math.ceil(height) });
  }

  /** Report document height whenever it changes (hosts size the iframe from this). */
  autoResize(doc: Document = document): () => void {
    if (typeof ResizeObserver === "undefined") return () => {};
    const el = doc.documentElement;
    const ro = new ResizeObserver(() => this.reportSize(el.scrollWidth, el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.post({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Json): void {
    this.port.post({ jsonrpc: "2.0", method, params });
  }

  private receive(m: RpcMessage): void {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result ?? {});
      return;
    }
    const params = m.params ?? {};
    switch (m.method) {
      case "ui/notifications/tool-input":
        this.onToolInput?.((params.arguments as Json) ?? {});
        break;
      case "ui/notifications/tool-result":
        this.onToolResult?.(params as ToolResult);
        break;
      case "ui/notifications/host-context-changed":
        this.hostContext = { ...this.hostContext, ...(params as HostContext) };
        this.onHostContext?.(this.hostContext);
        break;
      case "ui/resource-teardown":
        this.onTeardown?.();
        break;
    }
    // Every host → app request gets an answer, even ones we don't use.
    if (m.id !== undefined && m.method) this.port.post({ jsonrpc: "2.0", id: m.id, result: {} });
  }
}
