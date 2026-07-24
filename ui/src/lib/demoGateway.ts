/**
 * DemoGateway — in-browser mock backend for the web demo build.
 *
 * Implements the same public surface as GatewayClient (send / stream /
 * onConnectionChange / cancelRequest / connect) but answers everything
 * locally with fixture data. Active only when VITE_DEMO_MODE === "1".
 */
import type { GatewayResponse } from "./gateway";

type Chunk = { type: string; payload: unknown; timestamp: string };
const now = () => new Date().toISOString();
const ok = (data: unknown): GatewayResponse => ({
  id: crypto.randomUUID(),
  success: true,
  data,
});

/* ---------------- fixtures ---------------- */

const DEMO_APPS = [
  { name: "Account Research", desc: "Enrich target accounts before you reach out" },
  { name: "Pipeline Signals", desc: "Spot the deals heating up this week" },
  { name: "Outreach", desc: "Draft personalized follow-ups overnight" },
  { name: "Meeting Notes", desc: "Summaries and action items, auto-filed" },
  { name: "CRM Updater", desc: "Keep records fresh without the busywork" },
  { name: "Win Reports", desc: "Your weekly revenue recap, written for you" },
].map((a, i) => ({
  id: `demo-app-${i + 1}`,
  type: "app",
  title: a.name,
  name: a.name,
  description: a.desc,
  status: "active",
  createdAt: now(),
  updatedAt: now(),
}));

const DEMO_REPLY =
  "Here's what I'd focus on today. Northwind and Acme Logistics both opened " +
  "your proposal twice this week, and Klein Supply just raised a Series A. " +
  "I'd start with Northwind — your champion there viewed pricing yesterday. " +
  "Want me to draft a follow-up in your voice, or open Account Research for " +
  "the full picture?";

/* ---------------- keyed handlers ---------------- */

const handlers: Record<string, (payload: any) => unknown> = {
  "settings:get": () => ({}),
  "settings:save-ui-preferences": () => ({}),
  "app:list": () => DEMO_APPS,
  "app:get": (p) => DEMO_APPS.find((a) => a.id === p?.id) ?? DEMO_APPS[0],
  "chat:list": () => [],
  "chat:get-messages": () => [],
  "chat:create": () => ({ chatId: `demo-chat-${Date.now()}` }),
  "chat:update": () => ({}),
  "subagent:list": () => [],
  "jobs:list": () => [],
  "jobs:get": () => null,
  "db:query": () => ({ rows: [], columns: [] }),
  "agent:get-agent-stats": () => ({ totalRuns: 0, totalTokens: 0 }),
  "agent:get-cost-stats": () => ({ totalCostUsd: 0 }),
  "agent:stop": () => ({}),
};

function defaultFor(type: string): unknown {
  if (/:list$|:all$|s:get-all$/.test(type)) return [];
  // Objects, not null: callers read properties off responses
  return {};
}

/* ---------------- demo client ---------------- */

class DemoGateway {
  private connectionListeners = new Set<(c: boolean) => void>();

  connect(): void {
    queueMicrotask(() => this.connectionListeners.forEach((cb) => cb(true)));
  }

  isConnected(): boolean {
    return true;
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    queueMicrotask(() => cb(true));
    return () => this.connectionListeners.delete(cb);
  }

  async waitForConnection(): Promise<void> {
    /* always connected */
  }

  async send(type: string, payload?: unknown): Promise<GatewayResponse> {
    const h = handlers[type];
    return ok(h ? h(payload) : defaultFor(type));
  }

  async stream(
    _type: string,
    payload: unknown,
    onChunk: (chunk: unknown) => void,
    onRegistered?: (requestId: string) => void,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    onRegistered?.(requestId);
    // Real backend stamps chatId on every chunk — useAgent drops chunks without it
    const chatId =
      (payload as { chatId?: string } | null)?.chatId ?? "demo-chat";
    const emit = (c: Chunk) => {
      try {
        onChunk({ ...c, chatId });
      } catch (err) {
        console.warn("[DemoGateway] chunk handler error", c.type, err);
      }
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await sleep(500);
    emit({
      type: "tool-call",
      payload: {
        toolCallId: "demo-tool-1",
        toolName: "search_agent_memory",
        args: { query: "accounts with recent buying signals" },
      },
      timestamp: now(),
    });
    await sleep(700);
    emit({
      type: "tool-result",
      payload: {
        toolCallId: "demo-tool-1",
        toolName: "search_agent_memory",
        result: { matches: 3, summary: "24 accounts · 3 with fresh signals" },
      },
      timestamp: now(),
    });
    await sleep(400);
    for (const word of DEMO_REPLY.split(" ")) {
      emit({ type: "text-delta", payload: { text: word + " " }, timestamp: now() });
      await sleep(24);
    }
    emit({ type: "done", payload: {}, timestamp: now() });
  }

  cancelRequest(_requestId: string, _reason?: string): void {
    /* no-op in demo */
  }

  getConnectionState(): "connected" | "reconnecting" | "disconnected" {
    return "connected";
  }

  async subscribeStream(
    _chatId: string,
    _streamRequestId: string,
    _fromChunkIndex: number,
    _onChunk: (chunk: unknown) => void,
    _onRegistered?: (id: string) => void,
  ): Promise<void> {
    /* no active streams to recover in demo */
  }

  disconnect(): void {
    /* no-op in demo */
  }
}

export const demoGateway = new DemoGateway();
