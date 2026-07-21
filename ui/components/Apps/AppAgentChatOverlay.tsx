/**
 * Floating sub-agent chat panel for mini-app embedded assistant (desktop Paprwork).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppAgentChatConfig } from "../../../src/core/types/appAgentChat";
import { buildAppAgentChatContext } from "../../../src/core/types/appAgentChat";
import { gateway } from "../../src/lib/gateway";
import { MiniChatCard } from "../Chat/MiniChatCard";
import "./AppAgentChatOverlay.css";

export interface AppAgentChatOverlayProps {
  appId: string;
  appTitle: string;
  config: AppAgentChatConfig;
  subAgentName: string;
  subAgentIcon?: string;
  initialMessage?: string;
  onClose: () => void;
}

export function AppAgentChatOverlay({
  appId,
  appTitle,
  config,
  subAgentName,
  subAgentIcon,
  initialMessage,
  onClose,
}: AppAgentChatOverlayProps) {
  const [delegationId, setDelegationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const startedRef = useRef(false);

  const startSession = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStarting(true);
    setError(null);

    const reportChatId = `app-agent:${appId}`;
    const task =
      initialMessage?.trim() ||
      config.welcomeMessage?.trim() ||
      `Help me with ${appTitle}`;

    try {
      const response = await gateway.send("subagent:delegate", {
        useAgentId: config.subAgentId,
        task,
        context: buildAppAgentChatContext(appId, appTitle, config),
        reportChatId,
        background: true,
        appIds: [appId],
        delegatedBy: "app-user",
      });
      const run = (response.data as { run?: { id: string } })?.run;
      if (!run?.id) {
        throw new Error("Delegation did not return a run id");
      }
      setDelegationId(run.id);
      await gateway.send("subagent:join-chat", { delegationId: run.id });
    } catch (err) {
      setError((err as Error).message);
      startedRef.current = false;
    } finally {
      setStarting(false);
    }
  }, [appId, appTitle, config, initialMessage]);

  useEffect(() => {
    void startSession();
  }, [startSession]);

  const label = config.bubbleLabel ?? subAgentName;

  return (
    <div className="app-agent-chat-overlay" role="dialog" aria-label={`${label} chat`}>
      <div className="app-agent-chat-overlay__backdrop" onClick={onClose} />
      <div className="app-agent-chat-overlay__panel">
        <header className="app-agent-chat-overlay__header">
          <span>{label}</span>
          <button
            type="button"
            className="app-agent-chat-overlay__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="app-agent-chat-overlay__body">
          {starting && !delegationId && (
            <p className="app-agent-chat-overlay__status">Starting assistant…</p>
          )}
          {error && (
            <p className="app-agent-chat-overlay__error">{error}</p>
          )}
          {delegationId && (
            <MiniChatCard
              delegationId={delegationId}
              subAgentName={subAgentName}
              task={
                initialMessage?.trim() ||
                config.welcomeMessage ||
                `Help with ${appTitle}`
              }
              status="active"
              subAgentIcon={subAgentIcon}
              defaultExpanded
            />
          )}
        </div>
      </div>
    </div>
  );
}
