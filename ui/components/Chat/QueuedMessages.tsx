/**
 * QueuedMessages — follow-ups the user sent while the agent is working.
 *
 * Job to be done: "I said something mid-task — did it get through, and where
 * will the answer land?" So the message is shown where it will live: inline,
 * at the bottom of the transcript, below the work in progress, in the user's
 * own voice (same avatar/name/layout as a sent message), but ghosted. One
 * quiet line says when the agent will read it. When it is actually sent, the
 * real message mounts in the same spot and finishes ghost → solid
 * (see followUpLanding.ts). No separate queue tray, no new chrome.
 *
 * Interaction model (steer at tool boundary — Codex CLI / Claude Code style):
 *   Enter while working → message pends here; agent pauses after its current
 *   step, reads it, continues below it.
 *   "Send now" → stop the current step immediately and send this instead.
 *   Remove → drop it before the agent sees it.
 *
 * Follow-ups survive leaving the chat (stores/messageQueueStore.ts). Ones
 * restored after a restart are `held`: shown as "Not sent", never auto-sent.
 */
import React from "react";
import "./QueuedMessages.css";
import type { Artifact } from "../../stores/artifactsStore";
import type { ChatMessage } from "../../types/chat";
import { MessageItem } from "./MessageItem";

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
  /** Agent display name for the status line. */
  agentName?: string;
  /** True while the agent is mid-turn (it will read at the next step). */
  agentWorking?: boolean;
}

export function pendingStatusText(
  agentName: string,
  agentWorking: boolean,
  position: number,
  held = false,
): string {
  if (held) return "Not sent";
  if (!agentWorking) return "Sending…";
  if (position > 0) return `Queued · ${agentName} reads this next`;
  return `${agentName} reads this after the current step`;
}

export const QueuedMessages: React.FC<QueuedMessagesProps> = ({
  queue,
  onSendNow,
  onRemove,
  agentName = "Pen",
  agentWorking = true,
}) => {
  if (queue.length === 0) return null;

  return (
    <div className="pending-follow-ups" aria-live="polite">
      {queue.map((msg, index) => {
        const asMessage: ChatMessage = {
          id: msg.id,
          role: "user",
          content: msg.text,
        } as ChatMessage;
        return (
          <div
            key={msg.id}
            className={`pending-follow-up${msg.held ? " pending-follow-up--held" : ""}`}
            data-testid="pending-follow-up"
          >
            <MessageItem chatId={msg.chatId} message={asMessage} />
            <div className="pending-follow-up__meta">
              <span className="pending-follow-up__status">
                {pendingStatusText(agentName, agentWorking, index, msg.held)}
              </span>
              <span className="pending-follow-up__actions">
                <button
                  type="button"
                  className="pending-follow-up__action"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSendNow(msg.id)}
                  title={
                    agentWorking
                      ? "Stop the current step and send this now"
                      : "Send this message"
                  }
                >
                  {msg.held && !agentWorking ? "Send" : "Send now"}
                </button>
                <button
                  type="button"
                  className="pending-follow-up__action pending-follow-up__action--quiet"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onRemove(msg.id)}
                  aria-label="Remove message"
                  title="Remove"
                >
                  Remove
                </button>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
