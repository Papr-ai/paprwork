/**
 * Brief sections and their cards, with the hover actions (check / x / undo / edit note / chat).
 * Same markup as the Home app's render.js so focusPage.css draws it identically.
 */
import { useState } from "react";
import { openChat } from "./focusApi";
import { agentPrompt, itemTitle, type BriefItem, type Section } from "./brief";
import { AgentIcon, CheckIcon, DismissIcon, EditIcon, UndoIcon } from "./icons";
import { safeHtml } from "./safeHtml";

export type OnReview = (i: BriefItem, next: "complete" | "irrelevant" | "active") => void;

function Meta({ i }: { i: BriefItem }) {
  const r = i._review;
  if (!r) return null;
  return <>
    <span className={`review-badge ${r.status === "complete" ? "done" : "off"}`}>{r.status === "complete" ? "Completed" : "Irrelevant"}</span>
    {r.status === "irrelevant" && r.note ? <div className="review-note">Clarification: {r.note}</div> : null}
  </>;
}

function Icons({ i, onReview }: { i: BriefItem; onReview: OnReview }) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  if (i._review) {
    return <>
      <button type="button" className="hi-btn undo" title="Undo" onClick={stop(() => onReview(i, "active"))}><UndoIcon /></button>
      {i._review.status === "irrelevant" ? <button type="button" className="hi-btn edit" title="Edit note" onClick={stop(() => onReview(i, "irrelevant"))}><EditIcon /></button> : null}
    </>;
  }
  return <>
    <button type="button" className="hi-btn check" title="Mark complete" onClick={stop(() => onReview(i, "complete"))}><CheckIcon /></button>
    <button type="button" className="hi-btn dismiss" title="Mark irrelevant" onClick={stop(() => onReview(i, "irrelevant"))}><DismissIcon /></button>
  </>;
}

function Hover({ i, onReview, chat = true }: { i: BriefItem; onReview: OnReview; chat?: boolean }) {
  return (
    <div className="card-hi">
      <Icons i={i} onReview={onReview} />
      {chat ? <button type="button" className="hi-btn sparkle" title="Chat with agent" onClick={(e) => { e.stopPropagation(); openChat(agentPrompt(i)); }}><AgentIcon /></button> : null}
    </div>
  );
}

const SEV: Record<string, string> = { high: "sev-dot-high", low: "sev-dot-low", medium: "sev-dot-medium" };

function TimelineCard({ i, onReview }: { i: BriefItem; onReview: OnReview }) {
  const [open, setOpen] = useState(false);
  const ext = i.tags?.includes("external");
  return (
    <div className={`card${ext ? " card-ext" : ""}${open ? " expanded" : ""}`} data-idx="0" onClick={() => i.detail && setOpen(!open)}>
      <div className="tl-head"><span className="tl-time">{i.time}</span><span className="tl-title">{i.title}</span>
        <div className="tl-tags">{(i.tags ?? []).map((t) => <span key={t} className={`tag ${t === "external" ? "tag-ext" : "tag-int"}`}>{t}</span>)}</div></div>
      {i.detail ? <div className={`tl-detail${open ? " open" : ""}`}><div className="tl-detail-inner">
        {Object.entries(i.detail).map(([k, v]) => <div key={k} className="detail-row"><div className="detail-label">{k}</div><div className="detail-text">{v}</div></div>)}
      </div></div> : null}
      <Meta i={i} /><Hover i={i} onReview={onReview} />
    </div>
  );
}

function Card({ i, type, onReview }: { i: BriefItem; type: string; onReview: OnReview }) {
  switch (type) {
    case "timeline": return <TimelineCard i={i} onReview={onReview} />;
    case "priorities":
      return <div className="card"><div className="pri-head"><span className="pri-rank">{i.rank}</span><div className="pri-body"><div className="pri-title">{i.title}</div><div className="pri-why">{i.why ?? ""}</div></div></div><Meta i={i} /><Hover i={i} onReview={onReview} /></div>;
    case "tracker": {
      const pct = Math.round(((i.current ?? 0) / (i.target || 1)) * 100);
      return <div className="card"><div className="tracker-label"><span>{i.label}</span><span className="tracker-val">{i.current}/{i.target} {i.unit ?? ""}</span></div>
        <div className="tracker-bar-bg"><div className="tracker-bar-fill" style={{ width: `${pct}%` }} /></div>{i.context ? <div className="tracker-ctx">{i.context}</div> : null}<Meta i={i} /><Hover i={i} onReview={onReview} /></div>;
    }
    case "intel":
      return <div className="card"><div className="intel-subject">{i.subject}</div>{(i.bullets ?? []).map((b, k) => <div key={k} className="intel-bullet">{b}</div>)}
        {i.source ? <div className="intel-src">{i.source}</div> : null}<Meta i={i} /><Hover i={i} onReview={onReview} /></div>;
    case "alerts":
      return <div className={`card sev-${i.severity || "med"}`}><div className="alert-card"><span className="alert-icon"><span className={`alert-dot ${SEV[i.severity ?? ""] ?? "sev-dot-info"}`} /></span>
        <div><div className="alert-msg">{i.message}</div>{i.action ? <div className="alert-action">→ {i.action}</div> : null}</div></div><Meta i={i} /><Hover i={i} onReview={onReview} /></div>;
    default:
      return <div className="card reviewed-card"><div className="reviewed-kicker">{i._section}</div><div className="reviewed-title">{itemTitle(i)}</div>
        {i.why ? <div className="pri-why">{i.why}</div> : null}{i.context ? <div className="tracker-ctx">{i.context}</div> : null}{i.action ? <div className="alert-action">→ {i.action}</div> : null}
        <Meta i={i} /><Hover i={i} onReview={onReview} chat={false} /></div>;
  }
}

export function BriefSection({ s, onReview }: { s: Section; onReview: OnReview }) {
  return (
    <section className="section">
      <h2 className="section-title">{s.title}</h2>
      {s.type === "freeform"
        ? <div className="card"><div className="freeform" dangerouslySetInnerHTML={{ __html: safeHtml(s.content) }} /></div>
        : (s.items ?? []).map((i) => <Card key={i._id} i={i} type={s.type} onReview={onReview} />)}
    </section>
  );
}
