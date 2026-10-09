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
 * Motion (one change, one movement):
 *  - Remove / Edit: the message folds away and what is below slides up.
 *  - Send now: it stays put as "Sending…" (actions gone) until the real
 *    message mounts in the same spot; then the frame dissolves and the status
 *    line folds (followUpLanding.ts, LandingStatus). Dashed → gone = sent.
 *
 * Follow-ups survive leaving the chat (stores/messageQueueStore.ts). Ones
 * restored after a restart are `held`: "Not sent", never auto-sent.
 */
import React, { useLayoutEffect, useRef, useState } from "react";
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
  /** May be async (it interrupts the running step first). */
  onSendNow: (messageId: string) => void | Promise<void>;
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

/** How long a removed message takes to fold away. Matches queuedOut in the CSS. */
export const QUEUED_FOLD_MS = 240;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const Clock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** Same status line the queued message had, on the real message that replaces it; it folds away. */
export const LandingStatus: React.FC = () => (
  <div className="message-landing-meta" aria-hidden="true">
    <div>
      <span className="queued-item__status"><Clock />Sending…</span>
    </div>
  </div>
);

interface Leaving {
  msg: QueuedMessage;
  index: number;
  height: number;
}

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
  // Removed/edited messages stay on screen for one fold, then go.
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  // Send now: the message holds its place as "Sending…" until the real one lands.
  const [sending, setSending] = useState<Set<string>>(() => new Set());
  const els = useRef(new Map<string, HTMLDivElement>());
  const exits = useRef(new Map<string, number>());
  const prev = useRef<QueuedMessage[]>(queue);
  const timers = useRef<number[]>([]);

  useLayoutEffect(() => {
    const gone = prev.current
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => !queue.some((q) => q.id === msg.id));
    prev.current = queue;
    if (gone.length === 0) return;
    const folds = gone.filter(({ msg }) => exits.current.has(msg.id));
    if (folds.length > 0 && !prefersReducedMotion()) {
      const added = folds.map(({ msg, index }) => ({
        msg, index, height: exits.current.get(msg.id) ?? 0,
      }));
      setLeaving((l) => [...l, ...added]);
      const t = window.setTimeout(() => {
        setLeaving((l) => l.filter((x) => !added.some((a) => a.msg.id === x.msg.id)));
      }, QUEUED_FOLD_MS);
      timers.current.push(t);
    }
    gone.forEach(({ msg }) => exits.current.delete(msg.id));
    setSending((s) => (gone.some(({ msg }) => s.has(msg.id)) ? new Set([...s].filter((id) => queue.some((q) => q.id === id))) : s));
  }, [queue]);

  useLayoutEffect(() => () => timers.current.forEach(clearTimeout), []);

  if (queue.length === 0 && leaving.length === 0) return null;

  const fold = (id: string, act?: (id: string) => void) => () => {
    exits.current.set(id, els.current.get(id)?.offsetHeight ?? 0);
    act?.(id);
  };
  const sendNow = (id: string) => {
    setSending((s) => new Set(s).add(id));
    const clear = () => setSending((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    void Promise.resolve(onSendNow(id)).finally(clear);
  };

  const rows: Array<{ msg: QueuedMessage; ghost?: Leaving }> = queue.map((msg) => ({ msg }));
  [...leaving].sort((a, b) => a.index - b.index).forEach((g) =>
    rows.splice(Math.min(g.index, rows.length), 0, { msg: g.msg, ghost: g }));
  let position = -1;

  return (
    <div className="queued-list" role="list" aria-label="Queued messages" aria-live="polite">
      {rows.map(({ msg, ghost }) => {
        if (!ghost) position += 1;
        const isSending = !ghost && sending.has(msg.id);
        const cls = [
          "message-item queued-item",
          msg.held && "queued-item--held",
          isSending && "queued-item--sending",
          ghost && "queued-item--leaving",
        ].filter(Boolean).join(" ");
        return (
          <div
            key={msg.id}
            role="listitem"
            ref={(el) => { if (el) els.current.set(msg.id, el); else els.current.delete(msg.id); }}
            className={cls}
            style={ghost ? ({ "--queued-h": `${ghost.height}px` } as React.CSSProperties) : undefined}
            aria-hidden={ghost ? true : undefined}
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
                  {msg.held && !isSending ? <span className="queued-item__dot" /> : <Clock />}
                  {isSending ? "Sending…" : pendingStatusText(agentWorking, Math.max(position, 0), msg.held)}
                </span>
                {!isSending && !ghost && (
                  <span className="queued-item__actions">
                    {onEdit && (
                      <button type="button" onMouseDown={keepFocus} onClick={fold(msg.id, onEdit)}
                        aria-label="Edit message">Edit</button>
                    )}
                    <button type="button" onMouseDown={keepFocus} onClick={fold(msg.id, onRemove)}
                      aria-label="Remove message">Remove</button>
                    <button type="button" className="queued-item__send" onMouseDown={keepFocus}
                      onClick={() => sendNow(msg.id)}
                      aria-label={msg.held && !agentWorking ? "Send" : "Send now"}
                      title={agentWorking ? "Stop the current step and send this now" : undefined}>
                      {msg.held && !agentWorking ? "Send" : "Send now"}
                    </button>
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
