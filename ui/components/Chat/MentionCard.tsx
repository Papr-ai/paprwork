/**
 * A teammate's mention, as its own chat: what they asked, the action for you, and Pen's suggested
 * reply. One filled button sends it; Edit lets you change it first; Not now closes it unanswered.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./MentionCard.css";

export interface MentionCardData {
  type: "mention_inbox"; itemId: string; fromName: string; text: string;
  context: { chatTitle?: string }; action: { title: string; due?: string | null } | null;
  suggestedReply: string; nextStep?: string; status: "open" | "done" | "dismissed"; sentReply?: string;
}

export function parseMentionCard(toolName: string, result: unknown): MentionCardData | null {
  if (toolName !== "mention_inbox" || !result) return null;
  try {
    const d = (typeof result === "string" ? JSON.parse(result) : result) as MentionCardData;
    return d?.type === "mention_inbox" && d.itemId ? d : null;
  } catch {
    return null;
  }
}

export function MentionCard({ data }: { data: MentionCardData }) {
  const [card, setCard] = useState(data);
  const [draft, setDraft] = useState(data.suggestedReply);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.type === "collab:card" && d.data?.itemId === data.itemId) setCard((c) => ({ ...c, ...d.data.card }));
    };
    window.addEventListener("gateway-broadcast", on);
    return () => window.removeEventListener("gateway-broadcast", on);
  }, [data.itemId]);

  const answer = async (status: "done" | "dismissed", reply?: string) => {
    setBusy(true); setError(null);
    const r = await gateway.send("collab:answer", { itemId: card.itemId, status, reply }).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    if (!r.success) { setError(typeof r.error === "string" ? r.error : "Couldn't send. Try again."); return; }
    setCard((c) => ({ ...c, status, ...(reply ? { sentReply: reply } : {}) }));
    setEditing(false);
  };

  const closed = card.status !== "open";
  return (
    <section className={`mention-card${closed ? " is-closed" : ""}`} aria-label={`Mention from ${card.fromName}`}>
      <header className="mention-card__from">
        <b>{card.fromName}</b>{card.context?.chatTitle ? <span> in {card.context.chatTitle}</span> : null}
      </header>
      <p className="mention-card__text">{card.text}</p>
      {card.action ? (
        <p className="mention-card__action"><small>For you</small>{card.action.title}{card.action.due ? <em> · due {card.action.due}</em> : null}</p>
      ) : null}
      {closed ? (
        <p className="mention-card__done">
          {card.sentReply ? <>You replied: “{card.sentReply}”</> : card.status === "done" ? "Done" : "Closed without a reply"}
        </p>
      ) : (
        <div className="mention-card__reply">
          <small>Pen suggests</small>
          {editing ? (
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus aria-label="Your reply" />
          ) : (
            <p>{draft}</p>
          )}
          {card.nextStep ? <p className="mention-card__next">Next: {card.nextStep}</p> : null}
          {error ? <p className="mention-card__error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" className="mention-card__send" disabled={busy || !draft.trim()} onClick={() => void answer("done", draft.trim())}>
              {busy ? "Sending…" : `Send to ${card.fromName.split(" ")[0]}`}
            </button>
            {editing ? null : <button type="button" onClick={() => setEditing(true)} disabled={busy}>Edit</button>}
            <button type="button" onClick={() => void answer("dismissed")} disabled={busy}>Not now</button>
          </footer>
        </div>
      )}
    </section>
  );
}
