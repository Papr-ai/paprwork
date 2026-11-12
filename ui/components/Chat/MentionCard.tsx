/**
 * A teammate's mention, as its own chat — drawn like Focus's "Do this first" card: what they asked,
 * the action for you, and Pen's drafted reply (editable in place). Send it, or Not now to close it.
 */
import { useEffect, useRef, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { MentionPill } from "../common/mentionPill";
import "./MentionCard.css";

export interface MentionCardData {
  type: "mention_inbox"; itemId: string; fromName: string; text: string;
  context: { chatTitle?: string }; action: { title: string; due?: string | null } | null;
  suggestedReply: string; nextStep?: string; status: "open" | "done" | "dismissed"; sentReply?: string;
  investigating?: boolean; findings?: string; plan?: Array<{ step: string; kind: "check" | "change" }>; planStatus?: "approved";
}

/** What the chat runs when you approve Pen's plan: checks first, stop before changes if anything looks off. */
export function planPrompt(c: MentionCardData): string {
  const steps = (c.plan ?? []).map((p, i) => `${i + 1}. ${p.step}${p.kind === "change" ? " (change)" : ""}`).join("\n");
  return `Go ahead with the plan for ${c.fromName}'s ask${c.action ? ` (${c.action.title})` : ""}:\n${steps}\n\nDo the checks first; if anything differs from what we expected, stop and tell me before making changes. When done, draft my reply to ${c.fromName.split(" ")[0]} (mention id ${c.itemId}).`;
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

/** A person is a pill: photo (or initials) + name, same as chat and Focus. */
export function PersonPill({ name }: { name: string }) {
  return <MentionPill name={name} />;
}

/** Rows that fit the draft, so it reads as text, not a form field. */
export const draftRows = (s: string) => Math.min(8, Math.max(2, Math.ceil(s.length / 64)));

export function MentionCard({ data, chatId }: { data: MentionCardData; chatId?: string }) {
  const [card, setCard] = useState(data);
  const [draft, setDraft] = useState(data.suggestedReply);
  const touchedRef = useRef(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.type !== "collab:card" || d.data?.itemId !== data.itemId) return;
      setCard((c) => ({ ...c, ...d.data.card }));
      // Pen's checked draft replaces the quick one, unless you already started editing.
      if (d.data.card?.suggestedReply) setDraft((cur) => (touchedRef.current ? cur : d.data.card.suggestedReply));
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
  };

  const approve = async () => {
    setBusy(true); setError(null);
    const r = await gateway.send("collab:approve-plan", { itemId: card.itemId }).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    if (!r.success) { setError(typeof r.error === "string" ? r.error : "Couldn't start the plan. Try again."); return; }
    setCard((c) => ({ ...c, planStatus: "approved" }));
    window.dispatchEvent(new CustomEvent("papr-onboarding-send", { detail: { message: planPrompt(card), chatId } }));
  };

  const closed = card.status !== "open";
  const first = card.fromName.split(" ")[0] || card.fromName;
  const long = card.text.length > 240;
  return (
    <section className={`mention-card${closed ? " is-closed" : ""}`} aria-label={`Mention from ${card.fromName}`}>
      <header>
        <small>{closed ? (card.status === "done" ? "Answered" : "Closed") : "Asked of you"}</small>
        {card.action?.due ? <em className="mention-chip">due {card.action.due}</em> : null}
      </header>
      {card.action ? <h3>{card.action.title}</h3> : null}
      <span className="mention-card__from">
        <PersonPill name={card.fromName} />{card.context?.chatTitle ? <span>in {card.context.chatTitle}</span> : null}
      </span>
      <p className={`mention-card__text${long && !more ? " is-clamped" : ""}`}>{card.text}</p>
      {long ? <button type="button" className="mention-card__more" onClick={() => setMore(!more)}>{more ? "Less" : "More"}</button> : null}
      {closed ? (
        card.sentReply ? <p className="mention-card__done">You replied: “{card.sentReply}”</p> : null
      ) : (
        <>
          {card.investigating ? <p className="mention-check is-busy"><i aria-hidden />Pen is checking this before you reply…</p>
            : card.findings ? <p className="mention-check"><b>What Pen checked</b>{card.findings}</p> : null}
          <label className="mention-draft"><small>{card.findings ? "Pen drafted your reply" : "Pen's quick draft"}</small>
            <textarea value={draft} onChange={(e) => { touchedRef.current = true; setDraft(e.target.value); }} rows={draftRows(draft)} aria-label="Your reply" />
          </label>
          {card.plan?.length ? (
            <div className="mention-plan"><small>{card.planStatus === "approved" ? "Plan approved — Pen is on it below" : "Plan for your OK"}</small>
              <ol>{card.plan.map((p, i) => <li key={i}><span>{p.step}</span>{p.kind === "change" ? <em className="mention-chip is-change">changes</em> : <em className="mention-chip">read-only</em>}</li>)}</ol>
            </div>
          ) : card.nextStep ? <p className="mention-card__next">Next: {card.nextStep}</p> : null}
          {error ? <p className="mention-card__error" role="alert">{error}</p> : null}
          <div className="mention-acts">
            <button type="button" className="mention-primary" disabled={busy || !draft.trim()} onClick={() => void answer("done", draft.trim())}>
              {busy ? "Sending…" : `Send to ${first}`}
            </button>
            {card.plan?.length && card.planStatus !== "approved" ? (
              <button type="button" className="mention-secondary" disabled={busy} onClick={() => void approve()}>Approve plan</button>
            ) : null}
            <button type="button" className="mention-ghost" onClick={() => void answer("dismissed")} disabled={busy}>Not now</button>
          </div>
        </>
      )}
    </section>
  );
}
