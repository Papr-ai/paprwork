/**
 * MiniChatCard - Multi-turn sub-agent conversation card
 *
 * Shows message thread between main agent and sub-agent.
 * User can observe or click "Join" to participate.
 * Listens for subagent-chat:message, subagent-chat:question, subagent-chat:activity broadcasts.
 */

import React, { useState, useRef, useEffect } from "react";
import { Markdown } from "../common/Markdown";
import { gateway } from "../../src/lib/gateway";
import { ThinkingCard } from "./ThinkingCard";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
import "./MiniChatCard.css";

export interface SubAgentChatMessage {
  role: "user" | "assistant";
  author: "main-agent" | "sub-agent" | "user";
  content: string;
  timestamp: string;
}

/** Activity chunk from sub-agent (thinking, tool call, tool result) */
interface SubAgentActivityChunk {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface MiniChatCardProps {
  delegationId: string;
  subAgentName: string;
  task: string;
  status: "active" | "completed" | "failed";
  context?: string;
  resultText?: string;
  error?: string;
  /** Optional SVG icon name for sub-agent (e.g. "robot", "search", "code") */
  subAgentIcon?: string;
}

const STATUS_LABELS: Record<MiniChatCardProps["status"], string> = {
  active: "Running",
  completed: "Done",
  failed: "Failed",
};

/** Chat bubble icon for card header */
function ChatIcon() {
  return (
    <svg
      className="mini-chat-card__icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Sub-agent avatar - uses icon name or default robot */
function SubAgentAvatar({ icon }: { icon?: string }) {
  if (icon && SUBAGENT_ICONS[icon]) {
    const Svg = SUBAGENT_ICONS[icon];
    return (
      <span className="mini-chat-card__msg-avatar mini-chat-card__msg-avatar--sub">
        <Svg />
      </span>
    );
  }
  return (
    <svg
      className="mini-chat-card__msg-avatar"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M8 15h.01" />
      <path d="M16 15h.01" />
    </svg>
  );
}

/** Main agent avatar - Papr logo from main chat (gradient, no animation) */
function MainAgentAvatar() {
  return (
    <span className="mini-chat-card__msg-avatar mini-chat-card__msg-avatar--main">
      <svg
        width="16"
        height="16"
        viewBox="0 0 105 124"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="mini-chat-card__papr-logo-svg"
      >
        <path
          d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z"
          stroke="url(#papr-gradient-mini)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <defs>
          <linearGradient
            id="papr-gradient-mini"
            x1="17.2207"
            y1="89.4214"
            x2="68.8959"
            y2="35.8394"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#0060E0" />
            <stop offset="0.6" stopColor="#00ACFA" />
            <stop offset="1" stopColor="#0BCDFF" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}

/** Predefined sub-agent icons (sidebar-style SVGs) */
const SUBAGENT_ICONS: Record<string, React.FC<{ className?: string }>> = {
  robot: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M8 15h.01" />
      <path d="M16 15h.01" />
    </svg>
  ),
  search: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  ),
  code: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  pen: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    </svg>
  ),
  chart: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
};

/** User avatar - matches main chat (Vercel avatar or person icon fallback) */
function UserAvatar() {
  const avatarUrl = `https://avatar.vercel.sh/user`;
  return (
    <img
      src={avatarUrl}
      alt="You"
      className="mini-chat-card__msg-avatar mini-chat-card__msg-avatar--user-img"
      width={20}
      height={20}
    />
  );
}

export function MiniChatCard({
  delegationId,
  subAgentName,
  task,
  status,
  context,
  resultText,
  error,
  subAgentIcon,
}: MiniChatCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [messages, setMessages] = useState<SubAgentChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [activity, setActivity] = useState<{
    thinking: string;
    toolCalls: Array<{ name: string; args?: Record<string, unknown>; result?: unknown; status?: string }>;
  }>({ thinking: "", toolCalls: [] });
  const [isActivityStreaming, setIsActivityStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Subscribe to sub-agent chat broadcasts
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail?.type || !detail?.data) return;
      if (detail.data.delegationId && detail.data.delegationId !== delegationId)
        return;

      if (detail.type === "subagent-chat:message") {
        const msg = detail.data.message as SubAgentChatMessage;
        if (msg) {
          setMessages((prev) => {
            const recent = Date.now() - 3000;
            const isDup = prev.some(
              (m) =>
                m.content === msg.content &&
                m.author === msg.author &&
                new Date(m.timestamp).getTime() > recent,
            );
            if (isDup) return prev;
            return [...prev, msg];
          });
        }
      } else if (detail.type === "subagent-chat:question") {
        if (detail.data.delegationId === delegationId) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              author: "sub-agent",
              content: detail.data.question || "Question for main agent",
              timestamp: detail.data.timestamp || new Date().toISOString(),
            },
          ]);
        }
      } else if (detail.type === "subagent-chat:activity") {
        const chunk = detail.data.chunk as SubAgentActivityChunk;
        if (!chunk) return;

        setActivity((prev) => {
          const next = { ...prev };
          if (chunk.type === "reasoning-delta") {
            const text = (chunk.payload?.text as string) ?? "";
            next.thinking = prev.thinking + text;
            return next;
          }
          if (chunk.type === "tool-call") {
            next.toolCalls = [
              ...prev.toolCalls,
              {
                name: (chunk.payload?.toolName as string) ?? "tool",
                args: (chunk.payload?.args as Record<string, unknown>) ?? {},
              },
            ];
            next.thinking = "";
            return next;
          }
          if (chunk.type === "tool-result") {
            const result = chunk.payload?.result;
            const idx = next.toolCalls.findIndex((t) => t.result === undefined && t.status === undefined);
            if (idx >= 0) {
              next.toolCalls = [...next.toolCalls];
              next.toolCalls[idx] = { ...next.toolCalls[idx], result, status: "success" };
            }
            return next;
          }
          if (chunk.type === "tool-error") {
            const idx = next.toolCalls.findIndex((t) => t.status === undefined);
            if (idx >= 0) {
              next.toolCalls = [...next.toolCalls];
              next.toolCalls[idx] = { ...next.toolCalls[idx], status: "error" };
            }
            return next;
          }
          if (chunk.type === "text-delta" && prev.thinking) {
            next.thinking = "";
            return next;
          }
          return prev;
        });

        if (chunk.type === "reasoning-delta") {
          setIsActivityStreaming(true);
        } else if (chunk.type === "tool-call" || chunk.type === "tool-result" || chunk.type === "tool-error") {
          setIsActivityStreaming(false);
        }
      }
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [delegationId]);

  // Clear activity when status changes from active
  useEffect(() => {
    if (status !== "active") {
      setActivity({ thinking: "", toolCalls: [] });
      setIsActivityStreaming(false);
    }
  }, [status]);

  // Load delegation chat history on mount (and when user joins)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await gateway.send("subagent:get-messages", {
          delegationId,
          limit: 50,
        });
        const data = response.data as {
          messages?: Array<SubAgentChatMessage>;
        };
        if (!cancelled && data?.messages?.length) {
          setMessages((prev) => {
            const loaded = data.messages!;
            const loadedKeys = new Set(
              loaded.map((m) => `${m.timestamp}-${m.content}`),
            );
            const fromBroadcast = prev.filter(
              (m) => !loadedKeys.has(`${m.timestamp}-${m.content}`),
            );
            return [...loaded, ...fromBroadcast].sort(
              (a, b) =>
                new Date(a.timestamp).getTime() -
                new Date(b.timestamp).getTime(),
            );
          });
        }
      } catch (err) {
        if (!cancelled) console.warn("[MiniChatCard] Failed to load messages:", err);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [delegationId, hasJoined]);

  // Auto-scroll to latest message
  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleJoin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await gateway.send("subagent:join-chat", { delegationId });
      setHasJoined(true);
    } catch (err) {
      console.error("[MiniChatCard] Failed to join chat:", err);
    }
  };

  const handleSendMessage = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    try {
      await gateway.send("subagent:send-message", {
        delegationId,
        message: trimmed,
        author: "user",
      });
      setInputValue("");
      // Optimistic: add user message to UI (backend will broadcast; we could also add locally)
      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          author: "user",
          content: trimmed,
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      console.error("[MiniChatCard] Failed to send message:", err);
    } finally {
      setIsSending(false);
    }
  };

  const title = task.length > 40 ? `${task.slice(0, 40)}…` : task;
  const hasDetails =
    messages.length > 0 || !!resultText || !!error || !!context;

  return (
    <div className="mini-chat-card" data-testid="mini-chat-card">
      <button
        type="button"
        className="mini-chat-card__header"
        onClick={() => hasDetails && setIsCollapsed((c) => !c)}
      >
        <div className="mini-chat-card__header-left">
          <svg
            className={`mini-chat-card__chevron${isCollapsed ? "" : " mini-chat-card__chevron--expanded"}`}
            width="12"
            height="12"
            viewBox="0 0 12 12"
          >
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
            />
          </svg>
          <ChatIcon />
          <span className="mini-chat-card__title" title={task}>
            {subAgentName}: {title}
          </span>
        </div>
        <div className="mini-chat-card__header-right">
          {!hasJoined && (status === "active" || messages.length > 0) && (
            <button
              type="button"
              className="mini-chat-card__join-btn"
              onClick={handleJoin}
            >
              Join
            </button>
          )}
          <span
            className={`mini-chat-card__badge mini-chat-card__badge--${status}`}
          >
            {STATUS_LABELS[status]}
          </span>
        </div>
      </button>

      {!isCollapsed && (
        <div className="mini-chat-card__body">
          {context && <div className="mini-chat-card__context">{context}</div>}

          {/* Sub-agent activity: thinking + tool calls (like main chat) */}
          {(activity.thinking || activity.toolCalls.length > 0) && status === "active" && (
            <div className="mini-chat-card__activity">
              {activity.thinking && (
                <ThinkingCard
                  content={activity.thinking}
                  isStreaming={isActivityStreaming}
                  isCollapsible={true}
                />
              )}
              {activity.toolCalls.length > 0 && (
                <div className="mini-chat-card__tool-calls">
                  {activity.toolCalls.map((tc, i) => (
                    <div
                      key={i}
                      className={`mini-chat-card__tool-call mini-chat-card__tool-call--${tc.status ?? "pending"}`}
                    >
                      <span className="mini-chat-card__tool-name">
                        {getToolDisplayLabel({
                          toolName: tc.name,
                          args: tc.args,
                          status: tc.status,
                        })}
                      </span>
                      {tc.status === "success" && (
                        <span className="mini-chat-card__tool-status">✓</span>
                      )}
                      {tc.status === "error" && (
                        <span className="mini-chat-card__tool-status">✗</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.length > 0 && (
            <div className="mini-chat-card__messages">
              <div className="mini-chat-card__messages-header">
                Conversation
              </div>
              <div className="mini-chat-card__messages-content">
                {messages.map((msg, i) => (
                  <div
                    key={`${msg.timestamp}-${i}`}
                    className={`mini-chat-card__message mini-chat-card__message--${msg.author}`}
                  >
                    <div className="mini-chat-card__msg-avatar-wrap">
                      {msg.author === "sub-agent" ? (
                        <SubAgentAvatar icon={subAgentIcon} />
                      ) : msg.author === "main-agent" ? (
                        <MainAgentAvatar />
                      ) : (
                        <UserAvatar />
                      )}
                    </div>
                    <div className="mini-chat-card__message-bubble">
                      <div className="mini-chat-card__message-author">
                        {msg.author === "main-agent"
                          ? "Main Agent"
                          : msg.author === "sub-agent"
                            ? subAgentName
                            : "You"}
                      </div>
                      <div className="mini-chat-card__message-content">
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}

          {error && <div className="mini-chat-card__error">{error}</div>}

          {resultText && !error && status !== "active" && (
            <div className="mini-chat-card__result">
              <Markdown>{resultText}</Markdown>
            </div>
          )}

          {hasJoined && status === "active" && (
            <div className="mini-chat-card__input">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendMessage();
                  }
                }}
                placeholder="Type a message..."
                disabled={isSending}
              />
              <button
                type="button"
                onClick={() => void handleSendMessage()}
                disabled={!inputValue.trim() || isSending}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
