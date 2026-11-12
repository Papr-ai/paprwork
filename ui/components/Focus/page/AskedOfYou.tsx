/**
 * Asked of you: every open ask from a teammate, in Pen + Jev's order (in today's plan first, then
 * now → this week → FYI, then ones Pen is still checking). Each row: who, what, when + goal chips,
 * Pen's one-line why and draft reply; Reply opens the card, Done closes it, Not now = Later.
 */
import { useState } from "react";
import { focusEnv } from "./focusApi";
import { AgentIcon } from "./icons";
import { Pill, type NeedsUi } from "./NeedsSection";
import type { FocusFeed } from "../focusBridge";
import { WHEN_LABEL, type FeedAsk } from "./asks";

function Ask({ a, feed, ui, inPlan }: { a: FeedAsk; feed: FocusFeed; ui: NeedsUi; inPlan: boolean }) {
  const [open, setOpen] = useState(false);
  const notice = feed.needs.some((n) => n.key === a.key);
  const busy = ui.busy === a.key;
  const tag = inPlan ? "In today's plan" : a.when ? WHEN_LABEL[a.when] : "Pen is checking";
  return (
    <article className={`hcard hask${open ? " is-open" : ""}${a.when === "now" ? " is-urgent" : ""}`}>
      <div className="hcard-t" role="button" tabIndex={0} aria-expanded={open}
        onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, textarea")) setOpen(!open); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}>
        <span className="hcard-meta"><b className={`hask-when is-${a.when ?? "new"}`}>{tag}</b><Pill name={a.fromName} feed={feed} />
          {a.took ? <span>you&apos;re on it</span> : null}{a.goal ? <em className="hchip" title={`Moves ${a.goal}`}>{a.goal}</em> : null}</span>
        <h5>{a.title}</h5>
        {a.why ? <p className="hcard-body">{a.why}</p> : null}
        {a.draft && !a.took ? <p className="hpen"><i className="hpen-mk"><AgentIcon /></i><span>Reply drafted: “{a.draft}”</span></p> : null}
        {open && a.text && a.text !== a.title ? <p className="hcard-body">{a.text}</p> : null}
        {open && a.findings ? <p className="hcard-body"><b>Pen checked:</b> {a.findings}</p> : null}
        {ui.errors[a.key] ? <p className="hneed-err" role="alert">{ui.errors[a.key]}</p> : null}
      </div>
      <div className="hcard-a">
        <button type="button" className="hgo" onClick={() => void ui.run(a.key, "open", { key: a.key, chatId: a.chatId })}>Reply</button>
        {a.took ? <button type="button" className="hquiet" disabled={busy} onClick={() => void ui.run(a.key, "answer", { itemId: a.id, status: "done" })}>Done</button> : null}
        {notice && !focusEnv.web ? <button type="button" className="hquiet" onClick={() => void ui.run(a.key, "later", { key: a.key })}>Not now</button> : null}
      </div>
    </article>
  );
}

export function AskedOfYou({ feed, ui, planIds }: { feed: FocusFeed; ui: NeedsUi; planIds: Set<string> }) {
  if (!feed.asks.length) return null;
  return (
    <section className="hsec halso" id="asked"><h4>Asked of you <em>{feed.asks.length}</em></h4>
      {feed.asks.map((a) => <Ask key={a.id} a={a} feed={feed} ui={ui} inPlan={planIds.has(a.id)} />)}
    </section>
  );
}
