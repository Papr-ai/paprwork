/**
 * QueuedMessages — follow-ups the user sent while the agent is working.
 *
 * Where: in the thread, at the bottom, exactly where the message will land —
 * your avatar, your name, your words at full contrast. People read a thread
 * top-to-bottom as the order of events; putting the follow-up there answers
 * "where did my message go?" without a second place to look.
 *
 * One signal for "not sent yet": a dashed frame around the whole message,
 * avatar included (it sits on the thread's avatar column), plus one status line
 * (clock · "Sends after current step"). Messaging apps teach this already —
 * a pending message sits in the thread with a pending mark. We do NOT fade
 * the text: grey reads as failed or disabled.
 *
 * One motion: when the agent picks it up, the real message mounts in the
 * same spot and its dashed frame dissolves (followUpLanding.ts). Dashed →
 * gone means draft → sent.
 *
 * Follow-ups survive leaving the chat (stores/messageQueueStore.ts). Ones
 * restored after a restart are `held`: "Not sent", never auto-sent.
 */
import React from "react";
import "./QueuedMessages.css";
import type { Artifact } from "../../stores/artifactsStore";
import { UserAvatar } from "../common/UserAvatar";
import { useProfileStore } from "../../stores/profileStore";

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
  // Only the first in line is ever sending; the rest keep their place.
  if (position > 0) return "Queued";
  return agentWorking ? "Sends after current step" : "Sending…";
}

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const Clock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const QueuedMessages: React.FC<QueuedMessagesProps> = ({
  queue,
  onSendNow,
  onRemove,
  onEdit,
  agentWorking = true,
}) => {
  const userName = useProfileStore((s) => s.name);
  const userEmail = useProfileStore((s) => s.email);
  const userImageUrl = useProfileStore((s) => s.imageUrl);
  if (queue.length === 0) return null;

  return (
    <div className="queued-list" role="list" aria-label="Queued messages" aria-live="polite">
      {queue.map((msg, index) => (
        <div
          key={msg.id}
          role="listitem"
          className={`message-item queued-item${msg.held ? " queued-item--held" : ""}`}
          data-testid="queued-follow-up"
        >
          <div className="message-avatar-container">
            <UserAvatar imageUrl={userImageUrl} displayName={userName} email={userEmail}
              alt={userName || "User"} size={32} />
          </div>
          <div className="message-content queued-item__content">
            <div className="queued-item__card">
              <span className="message-sender-name">{userName || "You"}</span>
              <div className="message-text queued-item__text">{msg.text}</div>
            </div>
            <div className="queued-item__meta">
              <span className="queued-item__status">
                {msg.held ? <span className="queued-item__dot" /> : <Clock />}
                {pendingStatusText(agentWorking, index, msg.held)}
              </span>
              <span className="queued-item__actions">
                {onEdit && (
                  <button type="button" onMouseDown={keepFocus} onClick={() => onEdit(msg.id)}
                    aria-label="Edit message">Edit</button>
                )}
                <button type="button" onMouseDown={keepFocus} onClick={() => onRemove(msg.id)}
                  aria-label="Remove message">Remove</button>
                <button type="button" className="queued-item__send" onMouseDown={keepFocus}
                  onClick={() => onSendNow(msg.id)}
                  aria-label={msg.held && !agentWorking ? "Send" : "Send now"}
                  title={agentWorking ? "Stop the current step and send this now" : undefined}>
                  {msg.held && !agentWorking ? "Send" : "Send now"}
                </button>
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
