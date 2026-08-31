import { useEffect, useMemo, useRef, useState } from "react";
import type { AppAgentChatConfig } from "../../../src/core/types/appAgentChat";
import { Markdown } from "../common/Markdown";
import { ThinkingCard } from "../Chat/ThinkingCard";
import { WorkingCard } from "../Chat/WorkingCard";
import { ExploringCard } from "../Chat/ExploringCard";
import { PlanCard } from "../Chat/PlanCard";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
import type { ToolCall } from "../../types/core";
import {
  useEmbeddedAppAgentChat,
  type EmbeddedChatToolCall,
} from "../../hooks/useEmbeddedAppAgentChat";
import "../common/Markdown.css";
import "./EmbeddedAppAgentChatPanel.css";

export interface EmbeddedAppAgentChatPanelProps {
  appId: string;
  subAgentName: string;
  config: AppAgentChatConfig;
  initialMessage?: string;
  onAppRefresh?: () => void;
}

function mapToolCalls(toolCalls: EmbeddedChatToolCall[]): ToolCall[] {
  return toolCalls.map((tc, index) => ({
    id: tc.toolCallId ?? `embedded-tool-${index}`,
    toolName: tc.toolName,
    args: tc.args,
    status:
      tc.status === "pending"
        ? "calling"
        : tc.status === "success"
          ? "success"
          : "error",
    result:
      typeof tc.result === "string"
        ? tc.result
        : tc.result !== undefined
          ? JSON.stringify(tc.result)
          : undefined,
  }));
}

function getLastActivity(
  thinking: string,
  toolCalls: EmbeddedChatToolCall[],
  planTitle?: string,
): string {
  if (toolCalls.length > 0) {
    const lastTool = toolCalls[toolCalls.length - 1];
    return getToolDisplayLabel({
      toolName: lastTool.toolName,
      args: lastTool.args,
      status: lastTool.status === "pending" ? "calling" : lastTool.status,
    });
  }

  if (planTitle) {
    return planTitle;
  }

  const trimmedThinking = thinking.trim();
  if (trimmedThinking) {
    return trimmedThinking.length > 50
      ? `${trimmedThinking.slice(0, 50)}…`
      : trimmedThinking;
  }

  return "Working";
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
    plans,
    sendMessage,
    stopTurn,
    sessionId,
  } = useEmbeddedAppAgentChat({
    appId,
    config,
    initialMessage,
    onAppRefresh,
  });

  const mappedToolCalls = useMemo(
    () => mapToolCalls(toolCalls),
    [toolCalls],
  );

  const lastActivity = useMemo(
    () => getLastActivity(thinking, toolCalls, plans[plans.length - 1]?.title),
    [thinking, toolCalls, plans],
  );

  const hasStreamingActivity =
    sending && (thinking.length > 0 || toolCalls.length > 0 || plans.length > 0);

  const handleComposerAction = async () => {
    if (sending) {
      await stopTurn();
      return;
    }
    const trimmed = inputValue.trim();
    if (!trimmed || !sessionId) return;
    setInputValue("");
    await sendMessage(trimmed);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, toolCalls.length, plans.length, sending]);

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

        {hasStreamingActivity && (
          <div className="embedded-app-agent-chat__streaming">
            {thinking && (
              <ThinkingCard
                content={thinking}
                isStreaming={thinkingStreaming}
                isCollapsible
              />
            )}
            {(toolCalls.length > 0 || plans.length > 0) && (
              <WorkingCard
                isExploring={sending}
                lastActivity={lastActivity}
                contentRevision={toolCalls.length + plans.length}
              >
                {plans.map((plan) => (
                  <PlanCard key={plan.planId} data={plan} />
                ))}
                {toolCalls.length > 0 && (
                  <ExploringCard
                    toolCalls={mappedToolCalls}
                    isStreaming={sending}
                  />
                )}
              </WorkingCard>
            )}
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
          disabled={!sessionId || starting || sending}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleComposerAction();
            }
          }}
        />
        <button
          type="button"
          className={`embedded-app-agent-chat__send${sending ? " embedded-app-agent-chat__send--stop" : ""}`}
          disabled={(!inputValue.trim() && !sending) || !sessionId || starting}
          onClick={() => void handleComposerAction()}
        >
          {sending ? "Stop" : "Send"}
        </button>
      </div>
    </div>
  );
}
