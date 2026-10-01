/**
 * QueuedMessages — follow-ups the user sent while the agent is working.
 *
 * Where: a compact stack attached to the top of the input bar. Not in the
 * transcript. The transcript is a record of what the agent has actually
 * received; an unsent message is closer to a draft, so it lives next to the
 * composer, where the user's eyes already are when they queue, edit, or
 * cancel. (We tried rendering it ghosted inline in the transcript — grey
 * reads as "failed / disabled", and it scrolled out of reach.)
 *
 * Each row: the text (one line, click to expand), one status phrase, and
 * Edit / Remove / Send now. When the agent picks a message up, the row leaves
 * the stack and the real message lands in the transcript, solid, exactly
 * where the agent read it (followUpLanding.ts gives it a short slide-in).
 *
 * Follow-ups survive leaving the chat (stores/messageQueueStore.ts). Ones
 * restored after a restart are `held`: "Not sent", never auto-sent.
 */
import React, { useState } from "react";
import "./QueuedMessages.css";
import type { Artifact } from "../../stores/artifactsStore";

export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
  chatId: string;
  contextArtifacts?: Artifact[];
  /**
   * Restored from a previous session. Never auto-sent — the user decides
   * (Send / Remove), because hours-old intent should not fire on its own.
   */
  held?: boolean;
}

interface QueuedMessagesProps {
  queue: QueuedMessage[];
  onSendNow: (messageId: string) => void;
  onRemove: (messageId: string) => void;
  /** Move the message back into the input box to change it. */
  onEdit?: (messageId: string) => void;
  /** True while the agent is mid-turn (it will read at the next step). */
  agentWorking?: boolean;
}

export function pendingStatusText(
  agentWorking: boolean,
  position: number,
  held = false,
): string {
  if (held) return "Not sent";
  if (!agentWorking) return "Sending…";
  if (position > 0) return "Queued";
  return "Sends after current step";
}

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const Icon: React.FC<{ d: string }> = ({ d }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const EDIT = "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z";
const REMOVE = "M18 6L6 18M6 6l12 12";
const SEND = "M12 19V5M5 12l7-7 7 7";

export const QueuedMessages: React.FC<QueuedMessagesProps> = ({
  queue,
  onSendNow,
  onRemove,
  onEdit,
  agentWorking = true,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (queue.length === 0) return null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="queued-tray" role="list" aria-label="Queued messages" aria-live="polite">
      {queue.map((msg, index) => {
        const isOpen = expanded.has(msg.id);
        const sendLabel = msg.held && !agentWorking ? "Send" : "Send now";
        return (
          <div
            key={msg.id}
            role="listitem"
            className={`queued-row${msg.held ? " queued-row--held" : ""}`}
            data-testid="queued-follow-up"
          >
            <button
              type="button"
              className={`queued-row__text${isOpen ? " queued-row__text--open" : ""}`}
              onMouseDown={keepFocus}
              onClick={() => toggle(msg.id)}
              aria-expanded={isOpen}
              title={isOpen ? undefined : msg.text}
            >
              {msg.text}
            </button>
            <span className="queued-row__status">
              {pendingStatusText(agentWorking, index, msg.held)}
            </span>
            <span className="queued-row__actions">
              {onEdit && (
                <button type="button" className="queued-row__icon" onMouseDown={keepFocus}
                  onClick={() => onEdit(msg.id)} aria-label="Edit message" title="Edit">
                  <Icon d={EDIT} />
                </button>
              )}
              <button type="button" className="queued-row__icon" onMouseDown={keepFocus}
                onClick={() => onRemove(msg.id)} aria-label="Remove message" title="Remove">
                <Icon d={REMOVE} />
              </button>
              <button type="button" className="queued-row__icon queued-row__icon--send"
                onMouseDown={keepFocus} onClick={() => onSendNow(msg.id)} aria-label={sendLabel}
                title={agentWorking ? "Stop the current step and send this now" : "Send this message"}>
                <Icon d={SEND} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
};
