/**
 * Monday review, the fresh-start moment: did I focus, did it move, are these still the right three.
 * Banner above "Do this first" Mon–Wed until done for the week. Port of week_review.js (same localStorage key).
 */
import { useState } from "react";
import { focusApi, type FocusGoal, type FocusState } from "./focusApi";
import { hours, pace } from "./fmt";
import { ArrowIcon, BackIcon } from "./icons";
import { picksFrom } from "./EditThree";

const TARGET = 70;
const KEY = "papr.home.weekReview";

function weekKey(now = new Date()) {
  const d = new Date(now); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const reviewed = () => { try { return localStorage.getItem(KEY) === weekKey(); } catch { return false; } };
const markDone = () => { try { localStorage.setItem(KEY, weekKey()); } catch { /* storage off */ } };

export function reviewDue(data: FocusState | null, now = new Date()) {
  const day = now.getDay();
  return !!data?.three?.length && day >= 1 && day <= 3 && !reviewed();
}

export function ReviewBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="wrbanner" onClick={onOpen}>
      <span>Your Monday review is ready</span><b>2 min</b><ArrowIcon />
    </button>
  );
}

function range(now = new Date()) {
  const end = new Date(now); end.setDate(end.getDate() - 1);
  const start = new Date(now); start.setDate(start.getDate() - 7);
  const f = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", o);
  return `${f(start, { month: "short", day: "numeric" })}–${start.getMonth() === end.getMonth() ? end.getDate() : f(end, { month: "short", day: "numeric" })}`;
}

function Row({ g }: { g: FocusGoal }) {
  const s = g.signals ?? {};
  const [cls, label] = pace(s);
  const bits = [`${hours(s.hours7)} in chats`, s.openTasks ? `${s.openTasks} open task${s.openTasks > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  return <div className="wrrow"><b>{g.title}</b><span>{bits}</span><em className={`wrpill is-${cls}`}>{label}</em></div>;
}

export function WeekReview({ data, onClose, onChange, onSaved }: { data: FocusState; onClose: () => void; onChange: () => void; onSaved: (s: FocusState) => void }) {
  const [dropped, setDropped] = useState(false);
  const pct = data.alignedPct;
  const top = [...(data.candidates ?? [])].sort((a, b) => (b.signals?.hours7 || 0) - (a.signals?.hours7 || 0))[0];
  const drift = !dropped && top && (top.signals?.hours7 || 0) >= 3 ? top : null;
  const change = () => { markDone(); onChange(); };
  const keep = async () => {
    markDone();
    try { onSaved(await focusApi.saveThree(picksFrom(data.three))); } catch { /* keep the page; next load retries */ }
    onClose();
  };
  return (
    <div className="t3wrap wr">
      <button type="button" className="t3back" onClick={onClose}><BackIcon />Focus</button>
      <p className="hero-date">Monday review · {range()}</p>
      <h2 className="hero-title">{pct == null ? "Here's where last week went." : `Last week, ${pct}% of your chat time went to your three.`}</h2>
      {pct == null ? null : (
        <>
          <div className="wrbar"><i style={{ width: `${Math.min(100, pct)}%` }} /><b style={{ left: `${TARGET}%` }} title="Your target" /></div>
          <p className="t3sub">Your target is {TARGET}%. {pct >= TARGET ? "You hit it." : "Here's what it moved."}</p>
        </>
      )}
      <section className="wrlist">{data.three.map((g) => <Row key={g.id} g={g} />)}</section>
      {drift ? (
        <section className="wrdrift"><b>{hours(drift.signals?.hours7)} went to {drift.title}.</b>
          <p>It isn&apos;t one of your three. Make it one, or let it go this week?</p>
          <nav><button type="button" className="t3link" onClick={change}>Make it one of three</button>
            <button type="button" className="t3link quiet" onClick={() => setDropped(true)}>Let it go</button></nav>
        </section>
      ) : null}
      <h4 className="wrq">Still the right three for this week?</h4>
      <footer className="t3foot">
        <button type="button" className="hfocus-primary" onClick={() => void keep()}>Keep all three</button>
        <button type="button" className="hfocus-ghost" onClick={change}>Change one</button>
      </footer>
    </div>
  );
}
