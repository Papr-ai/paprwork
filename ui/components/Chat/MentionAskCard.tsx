/**
 * Pen's suggestion after an @: "Ask Shawkat?" with the ask Pen drafted. Edit it, then Ask or No.
 * Nothing reaches the teammate until Ask. After that it shows the ask's status (Asked, In progress, Done).
 * The answer itself lands in this chat as Pen's message; the ask is tracked under Waiting on in Focus.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./MentionCard.css";

export interface MentionAskData {
  type: "mention_ask"; ask: string; notified: boolean;
  mentioned: Array<{ name: string; mentionId: string }>; action: { title: string; due?: string | null } | null;
}

export function parseMentionAsk(toolName: string, result: unknown): MentionAskData | null {
  if (toolName !== "mention_person" || !result) return null;
  try {
    const r = (typeof result === "string" ? JSON.parse(result) : result) as { data?: MentionAskData };
    return r?.data?.type === "mention_ask" && r.data.mentioned?.length ? r.data : null;
  } catch {
    return null;
  }
}

type State = "suggested" | "asked" | "declined";
const key = (d: MentionAskData) => `mention-ask:${d.mentioned.map((m) => m.mentionId).join(",")}`;
const firstName = (n: string) => n.split(" ")[0] || n;

export function MentionAskCard({ data }: { data: MentionAskData }) {
  const [state, setState] = useState<State>(() => (data.notified ? "asked" : (localStorage.getItem(key(data)) as State) || "suggested"));
  const [draft, setDraft] = useState(data.ask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = data.mentioned.map((m) => firstName(m.name)).join(", ");
  useEffect(() => { localStorage.setItem(key(data), state); }, [state, data]);

  const ask = async () => {
    setBusy(true); setError(null);
    const r = await gateway.send("collab:notify", { ids: data.mentioned.map((m) => m.mentionId), note: draft.trim() !== data.ask ? draft.trim() : undefined })
      .catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    if (!r.success) { setError(typeof r.error === "string" ? r.error : "Couldn't send. Try again."); return; }
    setState("asked");
  };

  if (state === "declined") {
    return (
      <p className="mention-ask__note">Okay, I won't ask {names}. <button type="button" onClick={() => setState("suggested")}>Undo</button></p>
    );
  }
  if (state === "asked") {
    return (
      <p className="mention-ask__note">
        <span className="mention-ask__dot" aria-hidden="true" />Asked {names}{data.action?.due ? ` · due ${data.action.due}` : ""}
      </p>
    );
  }
  return (
    <section className="mention-card mention-ask" aria-label={`Ask ${names}?`}>
      <header className="mention-card__from"><b>Ask {data.mentioned.map((m) => m.name).join(", ")}?</b></header>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} aria-label="The ask" />
      <p className="mention-card__next">
        {data.action ? `${data.action.title}${data.action.due ? ` · due ${data.action.due}` : ""} · ` : ""}goes to {names}'s Focus as your ask
      </p>
      {error ? <p className="mention-card__error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="mention-card__send" disabled={busy || !draft.trim()} onClick={() => void ask()}>
          {busy ? "Asking…" : `Ask ${names}`}
        </button>
        <button type="button" onClick={() => setState("declined")} disabled={busy}>No</button>
      </footer>
    </section>
  );
}
