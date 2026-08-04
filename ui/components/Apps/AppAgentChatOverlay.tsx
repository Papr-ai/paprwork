/**
 * Floating sub-agent chat panel for mini-app embedded assistant (desktop Paprwork).
 * Uses session-based /api/app-agent/* (multi-turn), not one-shot delegate_task.
 */

import type { AppAgentChatConfig } from "../../../src/core/types/appAgentChat";
import { EmbeddedAppAgentChatPanel } from "./EmbeddedAppAgentChatPanel";
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
  config,
  subAgentName,
  initialMessage,
  onClose,
}: AppAgentChatOverlayProps) {
  const label = config.bubbleLabel ?? subAgentName;

  const handleAppRefresh = () => {
    window.dispatchEvent(
      new CustomEvent("papr-app-agent-refresh", { detail: { appId } }),
    );
  };

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
        <div className="app-agent-chat-overlay__body app-agent-chat-overlay__body--chat">
          <EmbeddedAppAgentChatPanel
            appId={appId}
            subAgentName={subAgentName}
            config={config}
            initialMessage={initialMessage}
            onAppRefresh={handleAppRefresh}
          />
        </div>
      </div>
    </div>
  );
}
