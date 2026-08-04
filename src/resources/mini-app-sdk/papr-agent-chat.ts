/**
 * Mini-app embedded sub-agent chat (floating bubble).
 *
 * Desktop (Paprwork iframe): uses window.paprAPI.invoke('chat.open', { subAgentId, appId, message })
 * Published web: live SSE chat via /api/app-agent/*
 *
 * Usage (auto-injected by enable_app_agent_chat):
 *   <script type="module" src="/__papr__/papr-agent-chat.js"></script>
 */

export interface PublicAppAgentChatConfig {
  enabled: boolean;
  subAgentId: string;
  bubbleLabel?: string;
  welcomeMessage?: string;
  bubblePosition?: "bottom-right" | "bottom-left";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ToolCallActivity {
  toolCallId?: string;
  name: string;
  args?: Record<string, unknown>;
  status?: "pending" | "success" | "error";
}

interface TurnActivity {
  thinking: string;
  thinkingStreaming: boolean;
  toolCalls: ToolCallActivity[];
}

export interface OpenAppAgentChatOptions {
  message?: string;
}

let openPanelHandler: ((options?: OpenAppAgentChatOptions) => void) | null = null;

function formatToolLabel(toolName: string, args?: Record<string, unknown>, running = true): string {
  const prefix = running ? "Using" : "Used";
  if (toolName === "read_app_file" && typeof args?.path === "string") {
    const path = args.path.split("/").pop() ?? args.path;
    return `${prefix} ${path}`;
  }
  if (toolName === "edit_app_file" && typeof args?.path === "string") {
    const path = args.path.split("/").pop() ?? args.path;
    return `${running ? "Editing" : "Edited"} ${path}`;
  }
  if (toolName === "edit_app_file_lines" && typeof args?.path === "string") {
    const path = args.path.split("/").pop() ?? args.path;
    return `${running ? "Editing" : "Edited"} ${path}`;
  }
  if (toolName === "list_app_files") {
    return running ? "Listing app files" : "Listed app files";
  }
  if (toolName === "bash" && typeof args?.command === "string") {
    const cmd = args.command.trim().slice(0, 40);
    return `${prefix} bash: ${cmd}${args.command.length > 40 ? "…" : ""}`;
  }
  const readable = toolName.replace(/_/g, " ");
  return `${prefix} ${readable}`;
}

const SESSION_STORAGE_KEY = "papr-app-agent-session";

function resolveAppIdFromPath(): string | null {
  const match = window.location.pathname.match(/\/apps\/([0-9a-f-]{36})\//i);
  return match?.[1] ?? null;
}

async function fetchAgentChatConfig(
  appId: string,
): Promise<PublicAppAgentChatConfig | null> {
  try {
    const res = await fetch(`/api/apps/${appId}/agent-chat`, {
      credentials: "same-origin",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        agentChat?: PublicAppAgentChatConfig | null;
      };
      if (data.agentChat) return data.agentChat;
    }
  } catch {
    /* fall through */
  }

  try {
    const metaRes = await fetch("./metadata.json", { credentials: "same-origin" });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as {
      agentChat?: PublicAppAgentChatConfig | null;
    };
    return meta.agentChat ?? null;
  } catch {
    return null;
  }
}

function loadStoredSessionId(appId: string): string | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { appId?: string; sessionId?: string };
    if (parsed.appId === appId && parsed.sessionId) {
      return parsed.sessionId;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveStoredSessionId(appId: string, sessionId: string): void {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({ appId, sessionId, updatedAt: new Date().toISOString() }),
  );
}

async function ensureSession(appId: string): Promise<string> {
  const existing = loadStoredSessionId(appId);
  if (existing) {
    try {
      const res = await fetch(`/api/app-agent/sessions/${existing}`, {
        credentials: "same-origin",
      });
      if (res.ok) {
        return existing;
      }
    } catch {
      /* create new */
    }
  }

  const res = await fetch("/api/app-agent/sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to create chat session (${res.status})`);
  }
  const data = (await res.json()) as { sessionId: string };
  saveStoredSessionId(appId, data.sessionId);
  return data.sessionId;
}

async function loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`/api/app-agent/sessions/${sessionId}`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as {
      messages?: Array<{ id: string; role: string; content: string }>;
    };
    return (data.messages ?? [])
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => ({
        id: msg.id,
        role: msg.role as "user" | "assistant",
        content: msg.content,
      }));
  } catch {
    return [];
  }
}

type WarmStatus = "idle" | "warming" | "ready" | "unavailable" | "failed";

async function warmSession(sessionId: string): Promise<{ status: WarmStatus; message?: string }> {
  const res = await fetch(`/api/app-agent/sessions/${sessionId}/warm`, {
    method: "POST",
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as {
    status?: WarmStatus;
    message?: string;
    error?: string;
  };
  if (!res.ok && !data.status) {
    throw new Error(data.error ?? `Warm failed (${res.status})`);
  }

  let status = data.status ?? "unavailable";
  if (status === "warming") {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const poll = await fetch(`/api/app-agent/sessions/${sessionId}/warm`, {
        credentials: "same-origin",
      });
      const pollData = (await poll.json()) as { status?: WarmStatus; message?: string };
      status = pollData.status ?? status;
      if (status === "ready" || status === "unavailable" || status === "failed") {
        return { status, message: pollData.message };
      }
    }
  }

  return { status, message: data.message };
}

function createBubbleStyles(): void {
  if (document.getElementById("papr-agent-chat-styles")) return;
  const style = document.createElement("style");
  style.id = "papr-agent-chat-styles";
  style.textContent = `
    .papr-agent-chat-bubble {
      position: fixed;
      z-index: 99999;
      bottom: 24px;
      width: 56px;
      height: 56px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      background: linear-gradient(135deg, #007aff 0%, #5856d6 100%);
      color: #fff;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .papr-agent-chat-bubble--left { left: 24px; }
    .papr-agent-chat-bubble--right { right: 24px; }
    .papr-agent-chat-panel {
      position: fixed;
      z-index: 99998;
      bottom: 92px;
      width: min(380px, calc(100vw - 32px));
      max-height: min(520px, calc(100vh - 120px));
      background: rgba(255,255,255,0.94);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.16);
      display: none;
      flex-direction: column;
      overflow: hidden;
      font: 14px/1.45 system-ui, -apple-system, sans-serif;
      color: #111;
    }
    .papr-agent-chat-panel--left { left: 24px; }
    .papr-agent-chat-panel--right { right: 24px; }
    .papr-agent-chat-panel--open { display: flex; }
    .papr-agent-chat-panel__header {
      padding: 12px 14px;
      font-weight: 600;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
    .papr-agent-chat-panel__messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .papr-agent-chat-msg {
      max-width: 92%;
      padding: 8px 12px;
      border-radius: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .papr-agent-chat-msg--user {
      align-self: flex-end;
      background: #007aff;
      color: #fff;
    }
    .papr-agent-chat-msg--assistant {
      align-self: flex-start;
      background: rgba(0,0,0,0.06);
    }
    .papr-agent-chat-msg--status {
      align-self: center;
      font-size: 12px;
      color: #666;
      background: transparent;
      padding: 4px 0;
    }
    .papr-agent-chat-activity {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 4px 0 8px;
    }
    .papr-agent-chat-thinking {
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 10px;
      background: rgba(0,0,0,0.03);
      overflow: hidden;
    }
    .papr-agent-chat-thinking__header {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      background: transparent;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      color: #555;
      cursor: pointer;
      text-align: left;
    }
    .papr-agent-chat-thinking__header--streaming {
      background: linear-gradient(90deg, rgba(0,122,255,0.08), rgba(88,86,214,0.08));
    }
    .papr-agent-chat-thinking__body {
      padding: 0 10px 10px;
      font-size: 12px;
      line-height: 1.4;
      color: #444;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
    }
    .papr-agent-chat-working {
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 10px;
      background: rgba(0,0,0,0.02);
      overflow: hidden;
    }
    .papr-agent-chat-working__header {
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 600;
      color: #555;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .papr-agent-chat-working__list {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .papr-agent-chat-tool {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 10px;
      font-size: 12px;
      color: #333;
      border-top: 1px solid rgba(0,0,0,0.04);
    }
    .papr-agent-chat-tool:first-child { border-top: none; }
    .papr-agent-chat-tool--pending { color: #666; }
    .papr-agent-chat-tool--success { color: #1a7f37; }
    .papr-agent-chat-tool--error { color: #c41e3a; }
    .papr-agent-chat-tool__status { flex-shrink: 0; font-weight: 700; }
    .papr-agent-chat-panel__composer {
      border-top: 1px solid rgba(0,0,0,0.06);
      padding: 10px 12px;
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    .papr-agent-chat-panel__input {
      flex: 1;
      border: 1px solid rgba(0,0,0,0.12);
      border-radius: 10px;
      padding: 8px 10px;
      font: inherit;
      resize: none;
      min-height: 38px;
      max-height: 120px;
    }
    .papr-agent-chat-panel__send {
      border: none;
      border-radius: 10px;
      padding: 0 14px;
      background: #007aff;
      color: #fff;
      font-weight: 600;
      cursor: pointer;
    }
    .papr-agent-chat-panel__send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    @media (prefers-color-scheme: dark) {
      .papr-agent-chat-panel {
        background: rgba(28,28,30,0.96);
        color: #f5f5f7;
        border-color: rgba(255,255,255,0.08);
      }
      .papr-agent-chat-msg--assistant { background: rgba(255,255,255,0.08); }
      .papr-agent-chat-msg--status { color: #aaa; }
      .papr-agent-chat-thinking,
      .papr-agent-chat-working {
        border-color: rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04);
      }
      .papr-agent-chat-thinking__header,
      .papr-agent-chat-working__header { color: #bbb; }
      .papr-agent-chat-thinking__body { color: #ccc; }
      .papr-agent-chat-tool { color: #ddd; border-color: rgba(255,255,255,0.06); }
      .papr-agent-chat-panel__input {
        background: rgba(255,255,255,0.06);
        color: #f5f5f7;
        border-color: rgba(255,255,255,0.12);
      }
    }
  `;
  document.head.appendChild(style);
}

function openDesktopChat(
  appId: string,
  config: PublicAppAgentChatConfig,
  message?: string,
): void {
  const paprAPI = (window as Window & { paprAPI?: { invoke: (m: string, o?: unknown) => Promise<unknown> } })
    .paprAPI;
  if (!paprAPI?.invoke) return;
  void paprAPI.invoke("chat.open", {
    mode: "app-agent",
    appId,
    subAgentId: config.subAgentId,
    message: message ?? config.welcomeMessage ?? "",
  });
}

async function streamTurn(
  sessionId: string,
  message: string,
  handlers: {
    onTurnStart?: () => void;
    onThinkingDelta: (text: string) => void;
    onDelta: (text: string) => void;
    onToolCall: (input: {
      toolCallId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    }) => void;
    onToolResult: (input: {
      toolCallId?: string;
      toolName: string;
      success: boolean;
    }) => void;
    onDone: (input: { shouldRefreshApp: boolean }) => void;
    onError: (error: string) => void;
  },
): Promise<void> {
  const postRes = await fetch(`/api/app-agent/sessions/${sessionId}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!postRes.ok) {
    const body = (await postRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Send failed (${postRes.status})`);
  }
  const { turnId } = (await postRes.json()) as { turnId: string };

  await new Promise<void>((resolve, reject) => {
    const source = new EventSource(
      `/api/app-agent/sessions/${sessionId}/stream?turnId=${encodeURIComponent(turnId)}`,
    );

    source.addEventListener("app-agent:turn-start", () => {
      handlers.onTurnStart?.();
    });

    source.addEventListener("app-agent:thinking-delta", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (typeof data.text === "string") {
          handlers.onThinkingDelta(data.text);
        }
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("app-agent:text-delta", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (typeof data.text === "string") {
          handlers.onDelta(data.text);
        }
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("app-agent:tool-call", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
        };
        if (data.toolName) {
          handlers.onToolCall({
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            args: data.args,
          });
        }
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("app-agent:tool-result", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          toolCallId?: string;
          toolName?: string;
        };
        if (data.toolName) {
          handlers.onToolResult({
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            success: true,
          });
        }
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("app-agent:tool-error", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          toolCallId?: string;
          toolName?: string;
        };
        if (data.toolName) {
          handlers.onToolResult({
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            success: false,
          });
        }
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("app-agent:turn-done", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          shouldRefreshApp?: boolean;
        };
        handlers.onDone({ shouldRefreshApp: Boolean(data.shouldRefreshApp) });
      } catch {
        handlers.onDone({ shouldRefreshApp: false });
      }
      source.close();
      resolve();
    });

    source.addEventListener("app-agent:error", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { error?: string };
        handlers.onError(data.error ?? "Assistant error");
      } catch {
        handlers.onError("Assistant error");
      }
      source.close();
      reject(new Error("Assistant error"));
    });

    source.onerror = () => {
      source.close();
      resolve();
    };
  });
}

function mountWidget(
  appId: string,
  config: PublicAppAgentChatConfig,
): () => void {
  createBubbleStyles();

  const side = config.bubblePosition === "bottom-left" ? "left" : "right";
  const messages: ChatMessage[] = [];
  let sessionId: string | null = null;
  let sending = false;

  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = `papr-agent-chat-bubble papr-agent-chat-bubble--${side}`;
  bubble.setAttribute("aria-label", config.bubbleLabel ?? "Open app assistant");
  bubble.title = config.bubbleLabel ?? "App assistant";
  bubble.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

  const panel = document.createElement("div");
  panel.className = `papr-agent-chat-panel papr-agent-chat-panel--${side}`;
  panel.innerHTML = `
    <div class="papr-agent-chat-panel__header">
      <span>${config.bubbleLabel ?? "App assistant"}</span>
      <button type="button" aria-label="Close" style="background:none;border:none;cursor:pointer;font-size:18px;line-height:1;color:inherit;">×</button>
    </div>
    <div class="papr-agent-chat-panel__messages"></div>
    <div class="papr-agent-chat-panel__composer">
      <textarea class="papr-agent-chat-panel__input" rows="1" placeholder="Ask the assistant…"></textarea>
      <button type="button" class="papr-agent-chat-panel__send">Send</button>
    </div>
  `;

  const messagesEl = panel.querySelector(".papr-agent-chat-panel__messages") as HTMLDivElement;
  const inputEl = panel.querySelector(".papr-agent-chat-panel__input") as HTMLTextAreaElement;
  const sendBtn = panel.querySelector(".papr-agent-chat-panel__send") as HTMLButtonElement;
  const closeBtn = panel.querySelector("button");

  let turnActivity: TurnActivity | null = null;
  let thinkingCollapsed = true;
  const thinkingPhrase = "Thinking…";

  const renderActivity = (container: HTMLElement): void => {
    if (!turnActivity) return;
    const hasThinking = turnActivity.thinking.length > 0;
    const hasTools = turnActivity.toolCalls.length > 0;
    if (!hasThinking && !hasTools) return;

    const activityEl = document.createElement("div");
    activityEl.className = "papr-agent-chat-activity";

    if (hasThinking) {
      const thinkingEl = document.createElement("div");
      thinkingEl.className = "papr-agent-chat-thinking";

      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = `papr-agent-chat-thinking__header${
        turnActivity.thinkingStreaming ? " papr-agent-chat-thinking__header--streaming" : ""
      }`;
      headerBtn.textContent = turnActivity.thinkingStreaming
        ? thinkingPhrase
        : `Thought process (${turnActivity.thinking.length > 80 ? "…" : ""})`;
      headerBtn.addEventListener("click", () => {
        thinkingCollapsed = !thinkingCollapsed;
        bodyEl.hidden = thinkingCollapsed;
      });

      const bodyEl = document.createElement("div");
      bodyEl.className = "papr-agent-chat-thinking__body";
      bodyEl.textContent = turnActivity.thinking;
      bodyEl.hidden = thinkingCollapsed;

      thinkingEl.appendChild(headerBtn);
      thinkingEl.appendChild(bodyEl);
      activityEl.appendChild(thinkingEl);
    }

    if (hasTools) {
      const workingEl = document.createElement("div");
      workingEl.className = "papr-agent-chat-working";
      const header = document.createElement("div");
      header.className = "papr-agent-chat-working__header";
      header.textContent = "Working";
      workingEl.appendChild(header);

      const list = document.createElement("div");
      list.className = "papr-agent-chat-working__list";
      for (const tool of turnActivity.toolCalls) {
        const row = document.createElement("div");
        const status = tool.status ?? "pending";
        row.className = `papr-agent-chat-tool papr-agent-chat-tool--${status}`;
        const label = document.createElement("span");
        label.textContent = formatToolLabel(
          tool.name,
          tool.args,
          status === "pending",
        );
        const badge = document.createElement("span");
        badge.className = "papr-agent-chat-tool__status";
        badge.textContent = status === "success" ? "✓" : status === "error" ? "✗" : "…";
        row.appendChild(label);
        row.appendChild(badge);
        list.appendChild(row);
      }
      workingEl.appendChild(list);
      activityEl.appendChild(workingEl);
    }

    container.appendChild(activityEl);
  };

  const renderMessages = (): void => {
    messagesEl.innerHTML = "";
    if (messages.length === 0 && config.welcomeMessage) {
      const welcome = document.createElement("div");
      welcome.className = "papr-agent-chat-msg papr-agent-chat-msg--assistant";
      welcome.textContent = config.welcomeMessage;
      messagesEl.appendChild(welcome);
    }
    for (const msg of messages) {
      const el = document.createElement("div");
      el.className = `papr-agent-chat-msg papr-agent-chat-msg--${msg.role}`;
      el.textContent = msg.content;
      messagesEl.appendChild(el);
    }
    renderActivity(messagesEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const appendStatus = (text: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.className = "papr-agent-chat-msg papr-agent-chat-msg--status";
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  };

  let open = false;
  let warmStatusEl: HTMLDivElement | null = null;
  let warmingInFlight = false;

  const hydrateSessionHistory = async (): Promise<void> => {
    if (!sessionId) {
      sessionId = await ensureSession(appId);
    }
    const history = await loadSessionMessages(sessionId);
    if (history.length > 0) {
      messages.splice(0, messages.length, ...history);
    }
  };

  const startWarmOnIntent = (): void => {
    if ((window as Window & { paprAPI?: unknown }).paprAPI) {
      return;
    }
    if (warmingInFlight) {
      return;
    }
    warmingInFlight = true;

    void (async () => {
      try {
        if (!sessionId) {
          sessionId = await ensureSession(appId);
        }
        if (!open || !sessionId) {
          return;
        }

        if (!warmStatusEl) {
          warmStatusEl = appendStatus("Starting assistant…");
        }

        const result = await warmSession(sessionId);
        if (warmStatusEl) {
          warmStatusEl.remove();
          warmStatusEl = null;
        }

        if (result.status === "failed" && open) {
          appendStatus(result.message ?? "Could not start assistant.");
        }
      } catch (err) {
        if (warmStatusEl) {
          warmStatusEl.remove();
          warmStatusEl = null;
        }
        if (open) {
          appendStatus((err as Error).message);
        }
      } finally {
        warmingInFlight = false;
      }
    })();
  };

  const setOpen = (next: boolean) => {
    open = next;
    panel.classList.toggle("papr-agent-chat-panel--open", open);
    if (open) {
      void hydrateSessionHistory()
        .catch(() => undefined)
        .finally(() => {
          renderMessages();
          startWarmOnIntent();
        });
    } else if (warmStatusEl) {
      warmStatusEl.remove();
      warmStatusEl = null;
    }
  };

  const sendMessage = async (prefilled?: string): Promise<void> => {
    const text = (prefilled ?? inputEl.value).trim();
    if (!text || sending) return;

    if ((window as Window & { paprAPI?: unknown }).paprAPI) {
      openDesktopChat(appId, config, text);
      inputEl.value = "";
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    inputEl.value = "";

    try {
      if (!sessionId) {
        sessionId = await ensureSession(appId);
      }

      messages.push({ id: `u-${Date.now()}`, role: "user", content: text });
      renderMessages();

      const assistantId = `a-${Date.now()}`;
      messages.push({ id: assistantId, role: "assistant", content: "" });
      turnActivity = { thinking: "", thinkingStreaming: false, toolCalls: [] };
      thinkingCollapsed = true;
      renderMessages();

      const assistantIndex = messages.findIndex((m) => m.id === assistantId);

      const findToolIndex = (toolCallId?: string, toolName?: string): number => {
        if (!turnActivity) return -1;
        if (toolCallId) {
          const byId = turnActivity.toolCalls.findIndex((t) => t.toolCallId === toolCallId);
          if (byId >= 0) return byId;
        }
        return turnActivity.toolCalls.findIndex(
          (t) => t.status === undefined && (!toolName || t.name === toolName),
        );
      };

      await streamTurn(sessionId, text, {
        onTurnStart: () => {
          turnActivity = { thinking: "", thinkingStreaming: false, toolCalls: [] };
          renderMessages();
        },
        onThinkingDelta: (delta) => {
          if (!turnActivity) return;
          turnActivity.thinking += delta;
          turnActivity.thinkingStreaming = true;
          renderMessages();
        },
        onDelta: (delta) => {
          if (turnActivity?.thinking) {
            turnActivity.thinkingStreaming = false;
          }
          if (assistantIndex >= 0) {
            messages[assistantIndex].content += delta;
            renderMessages();
          }
        },
        onToolCall: ({ toolCallId, toolName, args }) => {
          if (!turnActivity) return;
          turnActivity.thinking = "";
          turnActivity.thinkingStreaming = false;
          turnActivity.toolCalls.push({
            toolCallId,
            name: toolName,
            args,
            status: "pending",
          });
          renderMessages();
        },
        onToolResult: ({ toolCallId, toolName, success }) => {
          if (!turnActivity) return;
          const idx = findToolIndex(toolCallId, toolName);
          if (idx >= 0) {
            turnActivity.toolCalls[idx] = {
              ...turnActivity.toolCalls[idx],
              status: success ? "success" : "error",
            };
            renderMessages();
          }
        },
        onDone: ({ shouldRefreshApp }) => {
          if (turnActivity) {
            turnActivity.thinkingStreaming = false;
          }
          turnActivity = null;
          renderMessages();
          if (shouldRefreshApp) {
            window.setTimeout(() => location.reload(), 1500);
          }
        },
        onError: (error) => {
          turnActivity = null;
          if (assistantIndex >= 0 && !messages[assistantIndex].content) {
            messages[assistantIndex].content = error;
            renderMessages();
          } else {
            appendStatus(error);
          }
        },
      });
    } catch (err) {
      turnActivity = null;
      appendStatus((err as Error).message);
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  };

  const openPanel = (options?: OpenAppAgentChatOptions): void => {
    if ((window as Window & { paprAPI?: unknown }).paprAPI) {
      openDesktopChat(appId, config, options?.message);
      return;
    }
    setOpen(true);
    if (options?.message?.trim()) {
      void sendMessage(options.message.trim());
    }
  };

  openPanelHandler = openPanel;

  bubble.addEventListener("click", () => {
    if ((window as Window & { paprAPI?: unknown }).paprAPI) {
      openDesktopChat(appId, config);
      return;
    }
    setOpen(!open);
  });

  closeBtn?.addEventListener("click", () => setOpen(false));
  sendBtn.addEventListener("click", () => {
    void sendMessage();
  });
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  document.body.appendChild(panel);
  document.body.appendChild(bubble);
  renderMessages();

  return () => {
    if (openPanelHandler === openPanel) {
      openPanelHandler = null;
    }
    bubble.remove();
    panel.remove();
  };
}

export interface MountAppAgentChatOptions {
  appId?: string;
  config?: PublicAppAgentChatConfig;
}

export async function mountAppAgentChat(
  options: MountAppAgentChatOptions = {},
): Promise<() => void> {
  let appId = options.appId ?? resolveAppIdFromPath();

  let config = options.config ?? null;
  if (!config && appId) {
    config = await fetchAgentChatConfig(appId);
  }
  if (!config) {
    try {
      const metaRes = await fetch("./metadata.json", { credentials: "same-origin" });
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as {
          appId?: string;
          agentChat?: PublicAppAgentChatConfig | null;
        };
        if (meta.agentChat?.enabled) {
          config = meta.agentChat;
          appId = appId ?? meta.appId ?? null;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!appId) {
    console.warn("[PaprAgentChat] Could not resolve appId");
    return () => {};
  }
  if (!config?.enabled) {
    return () => {};
  }

  return mountWidget(appId, config);
}

declare global {
  interface Window {
    PaprAgentChat?: {
      mount: typeof mountAppAgentChat;
      open: (options?: OpenAppAgentChatOptions) => void;
    };
  }
}

export function openAppAgentChat(options?: OpenAppAgentChatOptions): void {
  if (openPanelHandler) {
    openPanelHandler(options);
    return;
  }
  console.warn("[PaprAgentChat] Chat not mounted yet — wait for mountAppAgentChat()");
}

window.PaprAgentChat = { mount: mountAppAgentChat, open: openAppAgentChat };

void mountAppAgentChat();
