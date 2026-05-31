/**
 * QueuedMessages Component - Displays queued messages waiting to be sent
 * Shows when agent is responding and user has queued additional messages
 */

import React, { useState } from "react";
import "./QueuedMessages.css";

export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
  chatId: string;
}

interface QueuedMessagesProps {
  queue: QueuedMessage[];
  onSendNow: (messageId: string) => void;
  onRemove: (messageId: string) => void;
}

export const QueuedMessages: React.FC<QueuedMessagesProps> = ({
  queue,
  onSendNow,
  onRemove,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (queue.length === 0) {
    return null;
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="queued-messages">
      {queue.map((msg) => {
        const isExpanded = expandedIds.has(msg.id);
        return (
          <div key={msg.id} className="queued-message-item">
            <span className="queued-message-label">Queued</span>
            <button
              type="button"
              className={`queued-message-text ${isExpanded ? 'queued-message-text-expanded' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent input from losing focus
                toggleExpanded(msg.id);
              }}
              aria-label={isExpanded ? "Collapse message" : "Expand message"}
            >
              {msg.text}
            </button>
            <div className="queued-message-actions">
              <button
                type="button"
                className="queued-message-icon-btn queued-message-delete-icon"
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent input from losing focus
                  e.stopPropagation();
                  onRemove(msg.id);
                }}
                title="Remove from queue"
                aria-label="Delete"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="queued-message-icon-btn queued-message-send-icon"
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent input from losing focus
                  e.stopPropagation();
                  onSendNow(msg.id);
                }}
                title="Stop current response and send this message now"
                aria-label="Send now"
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M2 10 L18 2 L10 18 L8 11 Z"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
