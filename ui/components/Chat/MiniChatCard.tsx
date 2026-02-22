/**
 * MiniChatCard - Multi-turn sub-agent conversation card
 *
 * Shows message thread between main agent and sub-agent.
 * User can observe or click "Join" to participate.
 * Listens for subagent-chat:message, subagent-chat:question, subagent-chat:user-joined broadcasts.
 */

import React, { useState, useRef, useEffect } from "react";
import { Markdown } from "../common/Markdown";
import { gateway } from "../../src/lib/gateway";
import "./MiniChatCard.css";

export interface SubAgentChatMessage {
  role: "user" | "assistant";
  author: "main-agent" | "sub-agent" | "user";
  content: string;
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

/** Sub-agent avatar (bot/assistant icon) */
function SubAgentAvatar() {
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

/** Main agent avatar (clock/circle - primary color) */
function MainAgentAvatar() {
  return (
    <svg
      className="mini-chat-card__msg-avatar mini-chat-card__msg-avatar--main"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

/** User avatar (person icon) */
function UserAvatar() {
  return (
    <svg
      className="mini-chat-card__msg-avatar mini-chat-card__msg-avatar--user"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
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
}: MiniChatCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [messages, setMessages] = useState<SubAgentChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
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
          setMessages((prev) => [...prev, msg]);
        }
      } else if (detail.type === "subagent-chat:question") {
        // Sub-agent asked a question - only show when delegationId matches
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
      }
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [delegationId]);

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
                    {msg.author === "sub-agent" && (
                      <div className="mini-chat-card__msg-avatar-wrap">
                        <SubAgentAvatar />
                      </div>
                    )}
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
                    {(msg.author === "main-agent" || msg.author === "user") && (
                      <div className="mini-chat-card__msg-avatar-wrap mini-chat-card__msg-avatar-wrap--end">
                        {msg.author === "main-agent" ? (
                          <MainAgentAvatar />
                        ) : (
                          <UserAvatar />
                        )}
                      </div>
                    )}
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
