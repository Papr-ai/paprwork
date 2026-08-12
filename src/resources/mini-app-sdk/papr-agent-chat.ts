/**
 * Mini-app embedded sub-agent chat (floating bubble).
 *
 * Desktop (Paprwork iframe): uses window.paprAPI.invoke('chat.open', { subAgentId, appId, message })
 * Published web: live SSE chat via /api/app-agent/*
 *
 * Usage (auto-injected by enable_app_agent_chat):
 *   <script type="module" src="/__papr__/papr-agent-chat.js"></script>
 */

import { renderMarkdownToHtml } from "./papr-markdown.js";
import {
  parsePlanFromToolResult,
  renderPlanCardHtml,
  type PlanData,
} from "./papr-agent-chat-plan.js";

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
  result?: unknown;
}

interface TurnActivity {
  thinking: string;
  thinkingStreaming: boolean;
  toolCalls: ToolCallActivity[];
  plans: PlanData[];
  startedAt: number;
}

export interface OpenAppAgentChatOptions {
  message?: string;
}

let openPanelHandler: ((options?: OpenAppAgentChatOptions) => void) | null = null;

const SESSION_STORAGE_KEY = "papr-agent-chat-session";

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

function setMessageMarkdown(el: HTMLElement, content: string): void {
  const contentEl = el.querySelector(".papr-agent-chat-msg__content");
  if (contentEl) {
    contentEl.innerHTML = renderMarkdownToHtml(content);
    return;
  }
  el.innerHTML = `<div class="papr-agent-chat-msg__content">${renderMarkdownToHtml(content)}</div>`;
}

function getLastToolActivity(toolCalls: ToolCallActivity[]): string {
  if (toolCalls.length === 0) return "Working";
  const last = toolCalls[toolCalls.length - 1];
  const running = (last.status ?? "pending") === "pending";
  return formatToolLabel(last.name, last.args, running);
}

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
    .papr-agent-chat-bubble--hidden { display: none !important; }
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
    .papr-agent-chat-panel--expanded {
      top: 0;
      bottom: 0;
      max-height: 100vh;
      width: min(440px, 42vw);
      border-radius: 0;
    }
    .papr-agent-chat-panel--expanded.papr-agent-chat-panel--right {
      right: 0;
      left: auto;
    }
    .papr-agent-chat-panel--expanded.papr-agent-chat-panel--left {
      left: 0;
      right: auto;
    }
    .papr-agent-chat-panel__header {
      padding: 12px 14px;
      font-weight: 600;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
      gap: 8px;
    }
    .papr-agent-chat-panel__header-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .papr-agent-chat-panel__header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .papr-agent-chat-panel__icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      color: inherit;
      opacity: 0.7;
      padding: 4px 6px;
      border-radius: 6px;
    }
    .papr-agent-chat-panel__icon-btn:hover { opacity: 1; background: rgba(0,0,0,0.05); }
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
      word-break: break-word;
    }
    .papr-agent-chat-msg__content {
      font-size: 14px;
      line-height: 1.55;
    }
    .papr-agent-chat-msg__content p {
      margin: 0 0 0.65em;
    }
    .papr-agent-chat-msg__content p:last-child {
      margin-bottom: 0;
    }
    .papr-agent-chat-msg__content h1,
    .papr-agent-chat-msg__content h2,
    .papr-agent-chat-msg__content h3 {
      margin: 0.75em 0 0.35em;
      font-weight: 600;
      line-height: 1.3;
    }
    .papr-agent-chat-msg__content h1 { font-size: 1.25rem; }
    .papr-agent-chat-msg__content h2 { font-size: 1.1rem; }
    .papr-agent-chat-msg__content h3 { font-size: 1rem; }
    .papr-agent-chat-msg__content ul,
    .papr-agent-chat-msg__content ol {
      margin: 0.35em 0 0.65em;
      padding-left: 1.25rem;
    }
    .papr-agent-chat-msg__content li {
      margin: 0.2em 0;
    }
    .papr-agent-chat-msg__content strong {
      font-weight: 600;
    }
    .papr-agent-chat-msg__content code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
      padding: 0.1em 0.35em;
      border-radius: 4px;
      background: rgba(0,0,0,0.06);
    }
    .papr-agent-chat-msg__content a {
      color: #007aff;
      text-decoration: none;
    }
    .papr-agent-chat-msg__content a:hover {
      text-decoration: underline;
    }
    .papr-agent-chat-msg__content blockquote {
      margin: 0.5em 0;
      padding-left: 0.75em;
      border-left: 3px solid rgba(0,0,0,0.12);
      color: #555;
    }
    .papr-md-pre {
      margin: 0.5em 0;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(0,0,0,0.06);
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.45;
    }
    .papr-md-pre code { background: none; padding: 0; }
    .papr-md-table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.5em 0;
      font-size: 12px;
    }
    .papr-md-table th, .papr-md-table td {
      border: 1px solid rgba(0,0,0,0.1);
      padding: 6px 8px;
      text-align: left;
    }
    .papr-md-table th { background: rgba(0,0,0,0.04); font-weight: 600; }
    .papr-agent-chat-plan {
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 10px;
      overflow: hidden;
      margin: 6px 0;
      background: rgba(0,0,0,0.02);
    }
    .papr-agent-chat-plan__header {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      background: transparent;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      text-align: left;
    }
    .papr-agent-chat-plan__chevron { font-size: 10px; transition: transform 0.2s; }
    .papr-agent-chat-plan__chevron--collapsed { transform: rotate(-90deg); }
    .papr-agent-chat-plan__title { flex: 1; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .papr-agent-chat-plan__progress { font-size: 11px; color: #666; }
    .papr-agent-chat-plan__bar { width: 48px; height: 4px; background: rgba(0,0,0,0.08); border-radius: 2px; overflow: hidden; }
    .papr-agent-chat-plan__bar span { display: block; height: 100%; background: #007aff; }
    .papr-agent-chat-plan__steps { padding: 0 10px 8px; }
    .papr-agent-chat-plan__steps--collapsed { display: none; }
    .papr-agent-chat-plan__step { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
    .papr-agent-chat-plan__step-icon { width: 14px; flex-shrink: 0; text-align: center; }
    .papr-agent-chat-plan__step--completed .papr-agent-chat-plan__step-desc { opacity: 0.6; text-decoration: line-through; }
    .papr-agent-chat-working__timer { margin-left: auto; font-size: 11px; color: #888; font-weight: 400; }
    .papr-agent-chat-panel__send--stop { background: #ff3b30; }
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
      font-size: 13px;
      font-weight: 600;
      color: #555;
      cursor: pointer;
      text-align: left;
    }
    .papr-agent-chat-thinking__chevron {
      font-size: 10px;
      transition: transform 0.2s ease;
      flex-shrink: 0;
    }
    .papr-agent-chat-thinking__chevron--collapsed {
      transform: rotate(-90deg);
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
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      font-size: 13px;
      font-weight: 600;
      color: #555;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      cursor: pointer;
      user-select: none;
    }
    .papr-agent-chat-working__chevron {
      font-size: 10px;
      transition: transform 0.2s ease;
      flex-shrink: 0;
    }
    .papr-agent-chat-working__chevron--collapsed {
      transform: rotate(-90deg);
    }
    .papr-agent-chat-working__label-secondary {
      font-weight: 400;
      color: #777;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .papr-agent-chat-working__body--collapsed,
    .papr-agent-chat-working__list--collapsed {
      display: none !important;
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
      .papr-agent-chat-working__label-secondary { color: #999; }
      .papr-agent-chat-tool { color: #ddd; border-color: rgba(255,255,255,0.06); }
      .papr-agent-chat-msg__content code {
        background: rgba(255,255,255,0.08);
      }
      .papr-agent-chat-msg__content blockquote {
        border-color: rgba(255,255,255,0.15);
        color: #bbb;
      }
      .papr-agent-chat-msg__content a { color: #64b5ff; }
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
    onTurnId?: (turnId: string) => void;
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
      result?: unknown;
    }) => void;
    onDone: (input: { shouldRefreshApp: boolean; stopped?: boolean }) => void;
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
  handlers.onTurnId?.(turnId);

  await new Promise<void>((resolve, reject) => {
    const source = new EventSource(
      `/api/app-agent/sessions/${sessionId}/stream?turnId=${encodeURIComponent(turnId)}`,
    );

    const finish = (): void => {
      source.close();
      resolve();
    };

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
          result?: unknown;
        };
        if (data.toolName) {
          handlers.onToolResult({
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            success: true,
            result: data.result,
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
          stopped?: boolean;
        };
        handlers.onDone({
          shouldRefreshApp: Boolean(data.shouldRefreshApp),
          stopped: Boolean(data.stopped),
        });
      } catch {
        handlers.onDone({ shouldRefreshApp: false });
      }
      finish();
    });

    source.addEventListener("app-agent:error", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { error?: string };
        handlers.onError(data.error ?? "Assistant error");
      } catch {
        handlers.onError("Assistant error");
      }
      finish();
      reject(new Error("Assistant error"));
    });

    source.onerror = () => {
      finish();
    };
  });

  return turnId;
}

async function cancelTurn(sessionId: string, turnId: string): Promise<void> {
  await fetch(`/api/app-agent/sessions/${sessionId}/turns/${turnId}/cancel`, {
    method: "POST",
    credentials: "same-origin",
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
      <span class="papr-agent-chat-panel__header-title">${config.bubbleLabel ?? "App assistant"}</span>
      <div class="papr-agent-chat-panel__header-actions">
        <button type="button" class="papr-agent-chat-panel__icon-btn papr-agent-chat-panel__expand" aria-label="Expand panel" title="Expand">⤢</button>
        <button type="button" class="papr-agent-chat-panel__icon-btn papr-agent-chat-panel__close" aria-label="Close">×</button>
      </div>
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
  const closeBtn = panel.querySelector(".papr-agent-chat-panel__close") as HTMLButtonElement;
  const expandBtn = panel.querySelector(".papr-agent-chat-panel__expand") as HTMLButtonElement;

  let expanded = false;
  let activeTurnId: string | null = null;
  let turnTimerInterval: ReturnType<typeof setInterval> | null = null;
  let elapsedSeconds = 0;

  expandBtn.addEventListener("click", () => {
    expanded = !expanded;
    panel.classList.toggle("papr-agent-chat-panel--expanded", expanded);
    expandBtn.textContent = expanded ? "⤡" : "⤢";
    expandBtn.title = expanded ? "Collapse" : "Expand";
    expandBtn.setAttribute("aria-label", expanded ? "Collapse panel" : "Expand panel");
  });

  let turnActivity: TurnActivity | null = null;
  let completedActivity: TurnActivity | null = null;
  let streamingAssistantId: string | null = null;
  let thinkingCollapsed = true;
  let workingCollapsed = true;
  let completedWorkingCollapsed = true;
  const thinkingPhrase = "Thinking…";

  const renderActivity = (
    container: HTMLElement,
    activity: TurnActivity | null,
    options: { live: boolean; sendingNow: boolean; collapsed: boolean },
  ): void => {
    if (!activity) return;
    const hasThinking = activity.thinking.length > 0;
    const hasTools = activity.toolCalls.length > 0;
    const hasPlans = activity.plans.length > 0;
    const showWaiting =
      options.live &&
      options.sendingNow &&
      !hasThinking &&
      !hasTools &&
      !hasPlans;

    if (!hasThinking && !hasTools && !hasPlans && !showWaiting) return;

    const activityEl = document.createElement("div");
    activityEl.className = "papr-agent-chat-activity";

    if (hasThinking) {
      const thinkingEl = document.createElement("div");
      thinkingEl.className = "papr-agent-chat-thinking";

      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = `papr-agent-chat-thinking__header${
        activity.thinkingStreaming ? " papr-agent-chat-thinking__header--streaming" : ""
      }`;
      headerBtn.innerHTML = `
        <span class="papr-agent-chat-thinking__chevron${
          thinkingCollapsed ? " papr-agent-chat-thinking__chevron--collapsed" : ""
        }">▼</span>
        <span>${
          activity.thinkingStreaming
            ? thinkingPhrase
            : "Thought process"
        }</span>
      `;
      headerBtn.addEventListener("click", () => {
        thinkingCollapsed = !thinkingCollapsed;
        renderMessages();
      });

      const bodyEl = document.createElement("div");
      bodyEl.className = "papr-agent-chat-thinking__body";
      bodyEl.textContent = activity.thinking;
      bodyEl.hidden = thinkingCollapsed;

      thinkingEl.appendChild(headerBtn);
      thinkingEl.appendChild(bodyEl);
      activityEl.appendChild(thinkingEl);
    }

    if (showWaiting || hasTools || hasPlans) {
      const workingEl = document.createElement("div");
      workingEl.className = "papr-agent-chat-working";
      const lastActivity = hasTools
        ? getLastToolActivity(activity.toolCalls)
        : activity.plans[activity.plans.length - 1]?.title ?? "Working";
      const isRunning =
        options.live &&
        (options.sendingNow ||
          activity.thinkingStreaming ||
          activity.toolCalls.some((t) => t.status === "pending" || !t.status));
      const header = document.createElement("button");
      header.type = "button";
      header.className = "papr-agent-chat-working__header";
      header.innerHTML = `
        <span class="papr-agent-chat-working__chevron${
          options.collapsed ? " papr-agent-chat-working__chevron--collapsed" : ""
        }">▼</span>
        <span>${isRunning ? "Working" : "Finished Working"}</span>
        ${
          options.collapsed
            ? `<span class="papr-agent-chat-working__label-secondary">${showWaiting ? "Starting…" : lastActivity}</span>`
            : ""
        }
        ${options.live && elapsedSeconds > 0 ? `<span class="papr-agent-chat-working__timer">${elapsedSeconds}s</span>` : ""}
      `;

      const list = document.createElement("div");
      list.className = `papr-agent-chat-working__list${
        options.collapsed ? " papr-agent-chat-working__list--collapsed" : ""
      }`;

      header.addEventListener("click", () => {
        if (options.live) {
          workingCollapsed = !workingCollapsed;
        } else {
          completedWorkingCollapsed = !completedWorkingCollapsed;
        }
        renderMessages();
      });

      workingEl.appendChild(header);

      if (hasPlans) {
        for (const plan of activity.plans) {
          const planWrap = document.createElement("div");
          planWrap.innerHTML = renderPlanCardHtml(plan, options.collapsed);
          const planEl = planWrap.firstElementChild;
          if (planEl) {
            const planHeader = planEl.querySelector(".papr-agent-chat-plan__header");
            planHeader?.addEventListener("click", () => {
              const steps = planEl.querySelector(".papr-agent-chat-plan__steps");
              const chevron = planEl.querySelector(".papr-agent-chat-plan__chevron");
              steps?.classList.toggle("papr-agent-chat-plan__steps--collapsed");
              chevron?.classList.toggle("papr-agent-chat-plan__chevron--collapsed");
            });
            list.appendChild(planEl);
          }
        }
      }

      for (const tool of activity.toolCalls) {
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

      if (hasTools || hasPlans) {
        workingEl.appendChild(list);
      }
      activityEl.appendChild(workingEl);
    }

    container.appendChild(activityEl);
  };

  const pruneEmptyAssistantMessages = (): void => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === "assistant" && !msg.content.trim()) {
        messages.splice(i, 1);
      }
    }
  };

  const renderMessages = (): void => {
    messagesEl.innerHTML = "";
    for (const msg of messages) {
      if (msg.role === "assistant" && !msg.content.trim()) {
        if (msg.id === streamingAssistantId && sending) {
          continue;
        }
        continue;
      }
      const el = document.createElement("div");
      el.className = `papr-agent-chat-msg papr-agent-chat-msg--${msg.role}`;
      setMessageMarkdown(el, msg.content);
      messagesEl.appendChild(el);
    }
    if (turnActivity) {
      renderActivity(messagesEl, turnActivity, {
        live: true,
        sendingNow: sending,
        collapsed: workingCollapsed,
      });
    } else if (completedActivity && !sending) {
      renderActivity(messagesEl, completedActivity, {
        live: false,
        sendingNow: false,
        collapsed: completedWorkingCollapsed,
      });
    }
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
      const welcome = messages.find((m) => m.id === "welcome");
      messages.splice(0, messages.length, ...history);
      if (welcome && !messages.some((m) => m.id === "welcome")) {
        messages.unshift(welcome);
      }
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
    bubble.classList.toggle("papr-agent-chat-bubble--hidden", open);
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

  const setSendingUi = (active: boolean): void => {
    sending = active;
    sendBtn.disabled = false;
    sendBtn.textContent = active ? "Stop" : "Send";
    sendBtn.classList.toggle("papr-agent-chat-panel__send--stop", active);
    inputEl.disabled = active;
  };

  const startTurnTimer = (): void => {
    elapsedSeconds = 0;
    if (turnTimerInterval) clearInterval(turnTimerInterval);
    turnTimerInterval = setInterval(() => {
      elapsedSeconds += 1;
      const timerEl = messagesEl.querySelector(".papr-agent-chat-working__timer");
      if (timerEl) {
        timerEl.textContent = `${elapsedSeconds}s`;
      } else if (turnActivity) {
        renderMessages();
      }
    }, 1000);
  };

  const stopTurnTimer = (): void => {
    if (turnTimerInterval) {
      clearInterval(turnTimerInterval);
      turnTimerInterval = null;
    }
  };

  const upsertPlan = (plan: PlanData): void => {
    if (!turnActivity) return;
    const idx = turnActivity.plans.findIndex((p) => p.planId === plan.planId);
    if (idx >= 0) {
      turnActivity.plans[idx] = plan;
    } else {
      turnActivity.plans.push(plan);
    }
  };

  const sendMessage = async (prefilled?: string): Promise<void> => {
    if (sending && activeTurnId && sessionId) {
      await cancelTurn(sessionId, activeTurnId);
      activeTurnId = null;
      stopTurnTimer();
      setSendingUi(false);
      turnActivity = null;
      streamingAssistantId = null;
      pruneEmptyAssistantMessages();
      renderMessages();
      return;
    }

    const text = (prefilled ?? inputEl.value).trim();
    if (!text || sending) return;

    if ((window as Window & { paprAPI?: unknown }).paprAPI) {
      openDesktopChat(appId, config, text);
      inputEl.value = "";
      return;
    }

    sending = true;
    setSendingUi(true);
    inputEl.value = "";
    completedActivity = null;

    try {
      if (!sessionId) {
        sessionId = await ensureSession(appId);
      }

      messages.push({ id: `u-${Date.now()}`, role: "user", content: text });
      renderMessages();

      const assistantId = `a-${Date.now()}`;
      streamingAssistantId = assistantId;
      messages.push({ id: assistantId, role: "assistant", content: "" });
      turnActivity = {
        thinking: "",
        thinkingStreaming: false,
        toolCalls: [],
        plans: [],
        startedAt: Date.now(),
      };
      thinkingCollapsed = true;
      workingCollapsed = true;
      completedWorkingCollapsed = true;
      startTurnTimer();
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
        onTurnId: (id) => {
          activeTurnId = id;
        },
        onTurnStart: () => {
          if (!turnActivity) {
            turnActivity = {
              thinking: "",
              thinkingStreaming: false,
              toolCalls: [],
              plans: [],
              startedAt: Date.now(),
            };
            renderMessages();
          }
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
        onToolResult: ({ toolCallId, toolName, success, result }) => {
          if (!turnActivity) return;
          const idx = findToolIndex(toolCallId, toolName);
          if (idx >= 0) {
            turnActivity.toolCalls[idx] = {
              ...turnActivity.toolCalls[idx],
              status: success ? "success" : "error",
              result,
            };
          }
          const plan = parsePlanFromToolResult(toolName, result);
          if (plan) {
            upsertPlan(plan);
          }
          renderMessages();
        },
        onDone: ({ shouldRefreshApp, stopped }) => {
          if (turnActivity) {
            turnActivity.thinkingStreaming = false;
            completedActivity = {
              thinking: turnActivity.thinking,
              thinkingStreaming: false,
              toolCalls: [...turnActivity.toolCalls],
              plans: [...turnActivity.plans],
              startedAt: turnActivity.startedAt,
            };
            completedWorkingCollapsed = true;
          }
          turnActivity = null;
          streamingAssistantId = null;
          activeTurnId = null;
          stopTurnTimer();
          setSendingUi(false);
          pruneEmptyAssistantMessages();
          renderMessages();
          if (sessionId) {
            void loadSessionMessages(sessionId)
              .then((history) => {
                if (history.length > 0) {
                  const welcome = messages.find((m) => m.id === "welcome");
                  messages.splice(0, messages.length, ...history);
                  if (welcome && !messages.some((m) => m.id === "welcome")) {
                    messages.unshift(welcome);
                  }
                  renderMessages();
                }
              })
              .catch(() => undefined);
          }
          if (shouldRefreshApp && !stopped) {
            window.setTimeout(() => location.reload(), 1500);
          }
        },
        onError: (error) => {
          turnActivity = null;
          streamingAssistantId = null;
          activeTurnId = null;
          stopTurnTimer();
          setSendingUi(false);
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
      activeTurnId = null;
      stopTurnTimer();
      setSendingUi(false);
      appendStatus((err as Error).message);
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

  if (config.welcomeMessage?.trim()) {
    messages.push({
      id: "welcome",
      role: "assistant",
      content: config.welcomeMessage.trim(),
    });
  }
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
