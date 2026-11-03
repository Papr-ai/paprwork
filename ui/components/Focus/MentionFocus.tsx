/**
 * Mentions in Focus, both sides.
 *  - AskCard: a teammate's ask, as a Needs you card with Pen's draft. Take it and reply (stays on Focus
 *    as your task until Mark done), Can't, or Later. Same card shape as every other Needs you item.
 *  - WaitingOn: what you asked others that's still open. Quiet rows, no pings; "Your turn" arrives as a notice.
 */
import { useCallback, useEffect, useState } from "react";
import type { Notice } from "../../../src/core/types/notices";
import { gateway } from "../../src/lib/gateway";
import { openNoticeOwner } from "../../stores/noticeOs";
import { useTabStore } from "../../stores/tabStore";

interface Card {
  itemId: string; fromName: string; text: string; chatId: string; suggestedReply: string; nextStep?: string;
  action: { title: string; due?: string | null } | null; status: "open" | "done" | "dismissed"; sentReply?: string;
}
const first = (n: string) => n.split(" ")[0] || n;
export const mentionItemId = (n: Notice) => (n.kind === "mention" && n.key.startsWith("mention:") ? n.key.slice(8) : null);

export function MentionAskFocus({ notice, menu, onLater }: { notice: Notice; menu: React.ReactNode; onLater: () => void }) {
  const itemId = mentionItemId(notice)!;
  const [card, setCard] = useState<Card | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void gateway.send("collab:card", { itemId }).then((r) => {
      const c = r.success ? (r.data as { card: Card | null }).card : null;
      if (c) { setCard(c); setDraft(c.suggestedReply); }
    }).catch(() => {});
  }, [itemId]);

  const answer = async (status: "open" | "done" | "dismissed", reply?: string) => {
    setBusy(true); setError(null);
    const r = await gateway.send("collab:answer", { itemId, status, reply }).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    if (!r.success) { setError(typeof r.error === "string" ? r.error : "Couldn't send. Try again."); return; }
    setCard((c) => (c ? { ...c, status, ...(reply ? { sentReply: reply } : {}) } : c));
  };

  const from = card?.fromName ?? notice.title.split(":")[0];
  const took = !!card?.sentReply && card.status === "open";
  const due = card?.action?.due ? ` · due ${card.action.due}` : "";
  return (
    <article className="needs-you__hero mention-focus">
      <header><small>{took ? "On your Focus" : "Do this first"}</small><span className="needs-you__from">{from} asked you{due}</span>{menu}</header>
      <h3>{card?.action?.title ?? notice.title}</h3>
      {card ? <p>{card.text}</p> : notice.body ? <p>{notice.body}</p> : null}
      {took ? (
        <p className="mention-focus__sent">You replied: “{card!.sentReply}”{card!.nextStep ? ` · Next: ${card!.nextStep}` : ""}</p>
      ) : card ? (
        <div className="mention-focus__pen">
          <small>Pen drafted your reply</small>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} aria-label="Your reply" />
        </div>
      ) : null}
      {error ? <p className="mention-focus__err" role="alert">{error}</p> : null}
      <footer className="mention-focus__acts">
        {took ? (
          <button type="button" className="needs-you__go" disabled={busy} onClick={() => void answer("done")}>Mark done</button>
        ) : (
          <button type="button" className="needs-you__go" disabled={busy || !card || !draft.trim()} onClick={() => void answer("open", draft.trim())}>
            {busy ? "Sending…" : "Take it and reply"}
          </button>
        )}
        {!took ? <button type="button" className="mention-focus__quiet" disabled={busy || !card} onClick={() => void answer("dismissed", draft.trim() && draft !== card?.suggestedReply ? draft.trim() : undefined)}>Can't</button> : null}
        <button type="button" className="mention-focus__quiet" onClick={onLater}>Later</button>
        <button type="button" className="mention-focus__quiet" onClick={() => openNoticeOwner(notice.owner, notice.key)}>Open chat</button>
      </footer>
    </article>
  );
}

interface Waiting { id: string; toName: string; title: string; due: string | null; state: "asked" | "took"; reply: string | null; chatId: string | null; chatTitle: string | null }

export function WaitingOn() {
  const [rows, setRows] = useState<Waiting[]>([]);
  const load = useCallback(() => {
    void gateway.send("collab:waiting", {}).then((r) => setRows(r.success ? (r.data as { waiting: Waiting[] }).waiting : [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const on = (e: Event) => { const t = (e as CustomEvent).detail?.type; if (t === "collab:mention" || t === "notifications:changed") load(); };
    window.addEventListener("gateway-broadcast", on);
    window.addEventListener("papr-workspace-switch-complete", load);
    return () => { window.removeEventListener("gateway-broadcast", on); window.removeEventListener("papr-workspace-switch-complete", load); };
  }, [load]);
  if (!rows.length) return null;
  const open = (w: Waiting) => {
    if (!w.chatId) return;
    const { tabs, createTab, switchToTab } = useTabStore.getState();
    const t = tabs.find((x) => x.type === "chat" && x.entityId === w.chatId);
    switchToTab(t?.id ?? createTab("chat", w.chatId, w.chatTitle ?? "Chat"));
  };
  return (
    <section className="needs-you mention-waiting" aria-label="Waiting on">
      <h2 className="needs-you__h">Waiting on<em>{rows.length}</em></h2>
      {rows.map((w) => (
        <button key={w.id} type="button" className="mention-waiting__row" onClick={() => open(w)} disabled={!w.chatId}>
          <b>{first(w.toName)} · {w.title}</b>
          <span>{w.due ? `due ${w.due}` : ""}{w.chatTitle ? `${w.due ? " · " : ""}${w.chatTitle}` : ""}</span>
          <ol className="mention-trail" aria-label={w.state === "took" ? "Took it" : "Asked"}>
            <li className="on">Asked</li><li className={w.state === "took" ? "on" : ""}>Took it</li><li>Done</li>
          </ol>
        </button>
      ))}
    </section>
  );
}
