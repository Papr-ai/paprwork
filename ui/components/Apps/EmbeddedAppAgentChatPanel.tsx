import { useEffect, useRef, useState } from "react";
import type { AppAgentChatConfig } from "../../../src/core/types/appAgentChat";
import { Markdown } from "../common/Markdown";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
import { useEmbeddedAppAgentChat } from "../../hooks/useEmbeddedAppAgentChat";
import "./EmbeddedAppAgentChatPanel.css";

export interface EmbeddedAppAgentChatPanelProps {
  appId: string;
  subAgentName: string;
  config: AppAgentChatConfig;
  initialMessage?: string;
  onAppRefresh?: () => void;
}

export function EmbeddedAppAgentChatPanel({
  appId,
  subAgentName,
  config,
  initialMessage,
  onAppRefresh,
}: EmbeddedAppAgentChatPanelProps) {
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    error,
    starting,
    sending,
    thinking,
    thinkingStreaming,
    toolCalls,
    sendMessage,
    sessionId,
  } = useEmbeddedAppAgentChat({
    appId,
    config,
    initialMessage,
    onAppRefresh,
  });

  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || sending || !sessionId) return;
    setInputValue("");
    await sendMessage(trimmed);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, toolCalls.length, sending]);

  return (
    <div className="embedded-app-agent-chat" data-testid="embedded-app-agent-chat">
      {starting && (
        <p className="embedded-app-agent-chat__status">Starting assistant…</p>
      )}
      {error && <p className="embedded-app-agent-chat__error">{error}</p>}

      <div className="embedded-app-agent-chat__messages">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`embedded-app-agent-chat__message embedded-app-agent-chat__message--${msg.role}`}
          >
            <div className="embedded-app-agent-chat__author">
              {msg.role === "user" ? "You" : subAgentName}
            </div>
            <div className="embedded-app-agent-chat__bubble">
              <Markdown>{msg.content}</Markdown>
            </div>
          </div>
        ))}

        {sending && (thinking || toolCalls.length > 0) && (
          <div className="embedded-app-agent-chat__activity">
            {thinking && (
              <div className="embedded-app-agent-chat__thinking">
                {thinkingStreaming ? "Thinking…" : "Thought process"}
                <div className="embedded-app-agent-chat__thinking-body">
                  {thinking}
                </div>
              </div>
            )}
            {toolCalls.map((tc, i) => (
              <div
                key={`${tc.toolName}-${i}`}
                className={`embedded-app-agent-chat__tool embedded-app-agent-chat__tool--${tc.status}`}
              >
                {getToolDisplayLabel({
                  toolName: tc.toolName,
                  args: tc.args,
                  status: tc.status === "pending" ? "calling" : tc.status,
                })}
              </div>
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="embedded-app-agent-chat__composer">
        <textarea
          className="embedded-app-agent-chat__input"
          rows={1}
          value={inputValue}
          placeholder="Ask the assistant…"
          disabled={!sessionId || starting}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          type="button"
          className="embedded-app-agent-chat__send"
          disabled={!inputValue.trim() || sending || !sessionId || starting}
          onClick={() => void handleSend()}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
