/**
 * Waiting on: what you asked others. One line each (who · what · due, state and their latest word);
 * click to open the thread right there: Reply, Nudge, Close, Open chat. Port of needs_wire.js Waiting.
 */
import { useState } from "react";
import type { FocusFeed, FeedWaiting } from "../focusBridge";
import type { NeedsUi } from "./NeedsSection";
import { ago } from "./fmt";
import { dueLabel } from "../../../../src/core/collab/promised";
import { type OnReview } from "./BriefCards";
import { itemTitle, type BriefItem, type Section } from "./brief";
import { openChat } from "./focusApi";

const first = (n: string) => String(n || "").split(/\s+/)[0] || n;
const since = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso) < 60_000 ? "just now" : ago(iso)) : "");

function Row({ w, ui, open, setOpen }: { w: FeedWaiting; ui: NeedsUi; open: boolean; setOpen: (id: string | null) => void }) {
  const [writing, setWriting] = useState(false);
  const name = first(w.toName), prog = w.state === "in_progress", busy = ui.busy === w.id;
  const due = w.promised ? ` · ${w.late ? "was due" : "due"} ${w.promised}` : w.due ? ` · due ${dueLabel(w.due)}` : "";
  const said = w.reply ? `${name}: “${w.reply}”` : !prog ? `asked ${since(w.at)} · no reply yet` : "";
  const nudged = !!w.nudgedAt && Date.now() - Date.parse(w.nudgedAt) < 6 * 3600e3;
  const text = ui.drafts[`w:${w.id}`] ?? "";
  const send = () => { const t = text.trim(); if (t) void ui.run(w.id, "followup", { itemId: w.id, kind: "reply", text: t }, () => { setWriting(false); ui.setDraft(`w:${w.id}`, ""); }); };
  return (
    <div className={`hwait-row${open || writing ? " is-open" : ""}`}>
      <button type="button" className="hwait-line" aria-expanded={open} onClick={() => { setOpen(open ? null : w.id); setWriting(false); }}>
        <span className="hwait-who">{name}</span><b>{w.title}{due}{w.blocks ? <em className="hwait-blocks">blocks {w.blocks}</em> : null}</b>
        <span className={w.late ? "is-late" : ""}>{prog ? "In progress" : "Asked"}{said ? ` · ${said}` : ""}</span>
      </button>
      {open || writing ? (
        <div className="hwait-more">
          {w.reply ? <q className="hwait-q">{w.reply}<small>{name} · {since(w.replyAt)}</small></q> : null}
          {w.mine && (!w.replyAt || w.mine.at > w.replyAt) ? <q className="hwait-q is-mine">{w.mine.text}<small>You · {since(w.mine.at)}</small></q> : null}
          {ui.errors[w.id] ? <p className="hneed-err" role="alert">{ui.errors[w.id]}</p> : null}
          {writing ? (
            <>
              <label className="hdraft"><textarea rows={2} autoFocus placeholder={`Write to ${name}`} value={text} onChange={(e) => ui.setDraft(`w:${w.id}`, e.target.value)} /></label>
              <div className="t3btns">
                <button type="button" className="t3save" disabled={busy} onClick={send}>{busy ? "Sending…" : `Send to ${name}`}</button>
                <button type="button" className="t3cancel" onClick={() => setWriting(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <div className="hwait-acts">
              <button type="button" className="t3link" onClick={() => setWriting(true)}>Reply</button>
              {!prog || w.late ? <button type="button" className="t3link" disabled={nudged || busy} onClick={() => void ui.run(w.id, "followup", { itemId: w.id, kind: "nudge", name })}>{nudged ? "Nudged" : "Nudge"}</button> : null}
              <button type="button" className="t3link" title={`Tell ${name} you don't need it anymore`} onClick={() => void ui.run(w.id, "followup", { itemId: w.id, kind: "close" })}>Close</button>
              {w.chatId ? <button type="button" className="t3link" onClick={() => void ui.run(w.id, "chat", { chatId: w.chatId, title: w.chatTitle || "Chat" })}>Open chat</button> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A promise Pen found outside Papr (a meeting, chat, email). Track it = Pen drafts a real ask you approve. */
function Said({ i, onReview }: { i: BriefItem; onReview: OnReview }) {
  const what = i.message || itemTitle(i);
  const track = () => openChat(`Turn this into a tracked ask: "${what}". Use mention_person with the ask written to them in my voice (who it is, what they said they'd do, by when), so I can approve it.`);
  return (
    <div className="hwait-row hsaid">
      <div className="hwait-line"><b>{what}</b>{i.action ? <span>{i.action}</span> : null}</div>
      <div className="hwait-acts">
        <button type="button" className="t3link" onClick={track}>Track it</button>
        <button type="button" className="t3link" title="Tell Pen you're not waiting on this; tomorrow's brief learns from it" onClick={() => onReview(i, "irrelevant")}>Not waiting</button>
      </div>
    </div>
  );
}

/**
 * You're waiting on: what you asked teammates in Papr (live), then "They said they would": promises
 * Pen found outside Papr that aren't tracked yet. Track it turns one into a real ask.
 */
export function WaitingSection({ feed, ui, notes, onReview }: { feed: FocusFeed; ui: NeedsUi; notes?: Section | null; onReview: OnReview }) {
  const [open, setOpen] = useState<string | null>(null);
  const said = (notes?.items ?? []).filter((i) => !i._review);
  if (!feed.waiting.length && !said.length) return null;
  return (
    <section className="hsec hwait" id="waiting"><h4>You&apos;re waiting on <em>{feed.waiting.length + said.length}</em></h4>
      {feed.waiting.map((w) => <Row key={w.id} w={w} ui={ui} open={open === w.id} setOpen={setOpen} />)}
      {said.length ? <><small className="hwait-notes">They said they would</small>{said.map((i) => <Said key={i._id} i={i} onReview={onReview} />)}</> : null}
    </section>
  );
}
