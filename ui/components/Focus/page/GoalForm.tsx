/**
 * The goal form inside Edit Focus: what you want, how often, what counts as done, and by when.
 * One-time goals get a date; daily/weekly goals are habits with no end date. Port of three_form.js.
 */
import { useState } from "react";
import type { FocusGoal, Repeat } from "./focusApi";

const REPEATS: [Repeat | "", string][] = [["", "One time"], ["daily", "Daily"], ["weekly", "Weekly"]];
const COPY = {
  "": { what: "Close Tranche 2", done: "Done when", ph: "$1.25M raised", tip: 'Name a result you can count, not an activity. "$1.25M raised" beats "work on the raise".' },
  daily: { what: "Post daily on X and LinkedIn", done: "Each day", ph: "1 post on X and LinkedIn", tip: "Small enough to do on your worst day. One post counts." },
  weekly: { what: "Publish every week", done: "Each week", ph: "3 posts and 1 long-form piece", tip: "What a good week looks like, in numbers you can count." },
};

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Saved due ("2026-11-30", or older free text like "Nov 30") → yyyy-mm-dd, or '' if unreadable. */
function isoDate(due?: string): string {
  const s = String(due || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(/\b\d{4}\b/.test(s) ? s : `${s} ${new Date().getFullYear()}`);
  return Number.isNaN(d.getTime()) ? "" : ymd(d);
}

export interface GoalFields { title: string; target: string; due: string; repeat?: Repeat; scope: string }

export function GoalForm({ g, own, onSave, onCancel }: { g: FocusGoal; own: boolean; onSave: (f: GoalFields) => void; onCancel: () => void }) {
  const [f, setF] = useState({
    title: own ? "" : g.title, target: own ? "" : g.target ?? "", due: own ? "" : isoDate(g.due),
    repeat: (own ? "" : g.repeat ?? "") as Repeat | "", scope: own ? "" : g.scope ?? "",
  });
  const c = COPY[f.repeat];
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    const title = f.title.trim();
    if (!title) return;
    onSave({ title, target: f.target.trim(), due: f.repeat ? "" : f.due, repeat: f.repeat || undefined, scope: f.scope.trim() });
  };
  return (
    <div className="t3edit" data-repeat={f.repeat}>
      <label><span>Outcome</span><input autoFocus value={f.title} placeholder={c.what} onChange={set("title")} onKeyDown={(e) => e.key === "Enter" && save()} /></label>
      <div className="t3field"><span>How often</span>
        <div className="t3seg" role="radiogroup" aria-label="How often">
          {REPEATS.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={k === f.repeat} onClick={() => setF({ ...f, repeat: k })}>{label}</button>
          ))}
        </div>
      </div>
      <div className="t3pair">
        <label><span>{c.done}</span><input value={f.target} placeholder={c.ph} onChange={set("target")} /></label>
        <label className="t3by"><span>By</span><input type="date" min={ymd(new Date())} value={f.due} onChange={set("due")} /></label>
      </div>
      <label><span>What counts</span><input value={f.scope} placeholder="Posts, comments, launch videos, integrations that reach new users" onChange={set("scope")} /></label>
      <p className="t3tip">{c.tip}</p>
      <div className="t3btns">
        <button type="button" className="t3save" onClick={save}>Save</button>
        <button type="button" className="t3cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
