/**
 * Modal wrapper for agent context / tool truncation settings
 */

import React, { useEffect } from "react";
import { ToolTruncationSettings } from "./ToolTruncationSettings";

interface AgentContextSettingsModalProps {
  onClose: () => void;
}

export function AgentContextSettingsModal({ onClose }: AgentContextSettingsModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="token-modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="token-modal agent-context-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-context-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="token-modal__header">
          <h2 id="agent-context-modal-title" className="token-modal__title">
            Agent Context
          </h2>
          <button
            type="button"
            className="token-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="token-modal__body agent-context-modal__body">
          <ToolTruncationSettings variant="modal" />
        </div>
      </div>
    </div>
  );
}
