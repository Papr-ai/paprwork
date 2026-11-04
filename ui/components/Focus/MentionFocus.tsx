/**
 * Mentions in Focus, both sides.
 *  - AskCard: a teammate's ask, as a Needs you card with Pen's draft. I'm on it (stays on Focus as
 *    In progress until Mark done), Can't, or Later. Same card shape as every other Needs you item.
 *  - WaitingOn: what you asked others that's still open. This is where you check progress, not the chat:
 *    status (Asked / In progress), their latest reply, and Reply / Nudge / Close / Open chat on the row.
 *    You're only notified when it's your move (done, can't, a question); In progress changes the row quietly.
 */
import { useCallback, useEffect, useState } from "react";
import type { Notice } from "../../../src/core/types/notices";
import { gateway } from "../../src/lib/gateway";
import { openNoticeOwner } from "../../stores/noticeOs";
import { useTabStore } from "../../stores/tabStore";
import { promiseLabel } from "../../../src/core/collab/promised";

interface Card {
  itemId: string; fromName: string; text: string; chatId: string; suggestedReply: string; nextStep?: string;
  action: { title: string; due?: string | null } | null; status: "open" | "done" | "dismissed"; sentReply?: string; promisedAt?: string | null;
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
    void gateway.send("collab:card", { itemId }).then((x) => { const c = x.success ? (x.data as { card: Card | null }).card : null; if (c) setCard(c); }).catch(() => {});
  };

  const from = card?.fromName ?? notice.title.split(":")[0];
  const took = !!card?.sentReply && card.status === "open";
  // Once they're on it, the date that matters is the one they said, not the one they were asked for.
  const when = took && card?.promisedAt ? ` · you said ${promiseLabel(card.promisedAt)}` : card?.action?.due ? ` · due ${card.action.due}` : "";
  return (
    <article className="needs-you__hero mention-focus">
      <header><small>{took ? "In progress" : "Do this first"}</small><span className="needs-you__from">{took ? first(from) : `${from} asked you`}{when}</span>{menu}</header>
      <h3>{card?.action?.title ?? notice.title}</h3>
      {took ? null : card ? <p>{card.text}</p> : notice.body ? <p>{notice.body}</p> : null}
      {took ? null : card ? (
        <div className="mention-focus__pen">
          <small>Pen drafted your reply</small>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} aria-label="Your reply" />
        </div>
      ) : null}
      {error ? <p className="mention-focus__err" role="alert">{error}</p> : null}
      <footer className="mention-focus__acts">
        {took ? (
          <>
            <button type="button" className="needs-you__go" disabled={busy} onClick={() => void answer("done")}>Done</button>
            <button type="button" className="mention-focus__quiet" disabled={busy} onClick={() => void answer("dismissed")}>Can't</button>
          </>
        ) : (
          <button type="button" className="needs-you__go" disabled={busy || !card || !draft.trim()} onClick={() => void answer("open", draft.trim())}>
            {busy ? "Sending…" : "I'm on it"}
          </button>
        )}
        {!took ? <button type="button" className="mention-focus__quiet" disabled={busy || !card} onClick={() => void answer("dismissed", draft.trim() && draft !== card?.suggestedReply ? draft.trim() : undefined)}>Can't</button> : null}
        {!took ? <button type="button" className="mention-focus__quiet" onClick={onLater}>Later</button> : null}
        <button type="button" className="mention-focus__quiet" onClick={() => openNoticeOwner(notice.owner, notice.key)}>Open chat</button>
      </footer>
    </article>
  );
}

interface Waiting {
  id: string; toName: string; title: string; due: string | null; state: "asked" | "in_progress"; reply: string | null; replyAt: string | null; promisedAt: string | null;
  mine: { text: string; at: string } | null; nudgedAt: string | null; chatId: string | null; chatTitle: string | null; at: string;
}

const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const NUDGE_MS = 6 * 3600_000;

function openChat(w: Waiting) {
  if (!w.chatId) return;
  const { tabs, createTab, switchToTab } = useTabStore.getState();
  const t = tabs.find((x) => x.type === "chat" && x.entityId === w.chatId);
  switchToTab(t?.id ?? createTab("chat", w.chatId, w.chatTitle ?? "Chat"));
}

function WaitingRow({ w, onChanged }: { w: Waiting; onChanged: () => void }) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const name = first(w.toName);
  const act = async (kind: "reply" | "nudge" | "close", body?: string) => {
    setBusy(kind); setNote(null);
    const r = await gateway.send("collab:followup", { itemId: w.id, kind, text: body }).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(null);
    if (!r.success) { setNote(typeof r.error === "string" ? r.error : "Couldn't send. Try again."); return; }
    if (kind === "reply") { setWriting(false); setText(""); }
    setNote(kind === "nudge" ? `Nudged ${name}` : null);
    onChanged();
  };
  const nudgedRecently = !!w.nudgedAt && Date.now() - Date.parse(w.nudgedAt) < NUDGE_MS;
  const prog = w.state === "in_progress";
  const late = !!w.promisedAt && Date.parse(w.promisedAt) < Date.now();
  return (
    <div className="mention-waiting__row">
      <i className="mention-waiting__av" aria-hidden="true">{initials(w.toName)}</i>
      <div className="mention-waiting__main">
        <div className="mention-waiting__top">
          <b>{name} · {w.title}</b>
          <span className={`mention-state${prog ? " is-prog" : ""}`}>{prog ? "In progress" : "Asked"}</span>
        </div>
        <span className={`mention-waiting__meta${late ? " is-late" : ""}`}>{w.promisedAt
          ? `${late ? "Was due" : "Promised"} ${promiseLabel(w.promisedAt)}`
          : `Asked ${ago(w.at)}${w.due ? ` · due ${w.due}` : ""}${!w.reply && !prog ? " · no reply yet" : ""}`}</span>
        {w.reply ? <q className="mention-waiting__q">{w.reply}<small>{name} · {ago(w.replyAt)}</small></q> : null}
        {w.mine && (!w.replyAt || w.mine.at > w.replyAt) ? <q className="mention-waiting__q is-mine">{w.mine.text}<small>You · {ago(w.mine.at)}</small></q> : null}
        {writing ? (
          <div className="mention-waiting__write">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus aria-label={`Reply to ${name}`}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void act("reply", text.trim()); if (e.key === "Escape") setWriting(false); }} />
            <div className="mention-waiting__acts">
              <button type="button" className="needs-you__go" disabled={!!busy || !text.trim()} onClick={() => void act("reply", text.trim())}>{busy === "reply" ? "Sending…" : `Send to ${name}`}</button>
              <button type="button" className="mention-focus__quiet" onClick={() => setWriting(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="mention-waiting__acts">
            <button type="button" className="mention-focus__quiet" onClick={() => setWriting(true)}>Reply</button>
            {!prog || late ? <button type="button" className="mention-focus__quiet" disabled={!!busy || nudgedRecently} onClick={() => void act("nudge")}>{nudgedRecently ? "Nudged" : "Nudge"}</button> : null}
            <button type="button" className="mention-focus__quiet" disabled={!!busy} onClick={() => void act("close")} title={`Tell ${name} you don't need it anymore`}>Close</button>
            {w.chatId ? <button type="button" className="mention-focus__quiet" onClick={() => openChat(w)}>Open chat</button> : null}
          </div>
        )}
        {note ? <p className="mention-waiting__note" role="status">{note}</p> : null}
      </div>
    </div>
  );
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("") || "?";

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
  return (
    <section className="needs-you mention-waiting" aria-label="Waiting on">
      <h2 className="needs-you__h">Waiting on<em>{rows.length}</em></h2>
      {rows.map((w) => <WaitingRow key={w.id} w={w} onChanged={load} />)}
    </section>
  );
}
