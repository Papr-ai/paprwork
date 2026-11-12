/**
 * One goal: where it stands, what moves it, one tap to work on it with Pen. Port of three.js detail()
 * and three_track.js (the "Results" card that starts a tracker).
 */
import { useState } from "react";
import { focusApi, openChat, type FocusGoal, type Task } from "./focusApi";
import { daysLeft, fmtDue, goalSub, pace } from "./fmt";
import { BackIcon, SparkIcon } from "./icons";
import { GoalHero } from "./GoalHero";
import { TaskRow } from "./TasksView";

function chatAbout(g: FocusGoal) {
  const habit = g.repeat ? ` This repeats ${g.repeat === "daily" ? "every day" : "every week"}; help me get ${g.repeat === "daily" ? "today's" : "this week's"} done.` : "";
  openChat(`Help me move my goal "${g.title}" forward today.${g.target ? ` ${g.repeat ? (g.repeat === "daily" ? "Each day" : "Each week") : "Done when"}: ${g.target}.` : ""}${habit}${g.due && !g.repeat ? ` Due ${g.due}.` : ""}${g.nextStep ? ` Next milestone: ${g.nextStep}.` : ""} Look at its open tasks and recent chats, then give me the one next step and do the first part with me.`);
}

function Track({ g, onStarted }: { g: FocusGoal; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = g.tracker;
  // Numbers live in the hero; this card only covers getting a tracker going.
  if (!t || (t.status === "active" && t.metrics)) return null;
  if (t.status === "active") return <section className="hsec t3track"><h4>Results</h4><p className="t3sub">Tracking {t.title}. First numbers land after its first run.</p></section>;
  if (t.status === "needs_connect") {
    return (
      <section className="hsec t3track"><h4>Results</h4><p className="t3sub">Track {t.title} automatically. Connect {(t.missing ?? []).join(" or ")} first.</p>
        <button type="button" className="hfocus-ghost" onClick={() => openChat(`Connect ${(t.missing ?? []).join(" and ")} so Focus can track my goal "${g.title}".`)}>Connect</button></section>
    );
  }
  const start = async () => {
    setBusy(true); setErr(null);
    try { await focusApi.startTracker(g.id); onStarted(); } catch (e) { setErr(`Couldn't start: ${(e as Error).message}`.slice(0, 80)); }
    setBusy(false);
  };
  return (
    <section className="hsec t3track"><h4>Results</h4>
      <p className="t3sub">{t.status === "ready" ? `Uses ${(t.connected ?? []).join(" + ")}, which you already connected. Runs daily.` : "Pen builds a daily job that measures this goal from the tools you already use."}</p>
      <button type="button" className="hfocus-ghost" disabled={busy} onClick={() => void start()}>
        {busy ? "Setting up…" : err ?? (t.status === "ready" ? `Track ${t.title}` : "Build a tracker for this goal")}
      </button>
    </section>
  );
}

interface Props { g: FocusGoal; three: FocusGoal[]; tasks: Task[]; onClose: () => void; onEdit: (id: string) => void; onPromote: (id: string) => void; onChanged: () => void }

export function GoalDetail({ g, three, tasks, onClose, onEdit, onPromote, onChanged }: Props) {
  const left = daysLeft(g.due);
  const done = g.repeat ? goalSub(g) : [g.target, g.due ? `${fmtDue(g.due)}${left != null ? ` · ${left} days left` : ""}` : ""].filter(Boolean).join(" · ");
  // The server says which tasks move this goal. Matching by id alone leaked other goals' tasks in.
  const want = Array.isArray(g.taskIds) ? new Set(g.taskIds) : null;
  const mine = tasks.filter((t) => t.status === "open" && (want ? want.has(t.id) : t.goal_id === g.id));
  const [pcls, plabel] = pace(g.signals);
  const inThree = three.some((x) => x.id === g.id);
  return (
    <div className="t3wrap">
      <button type="button" className="t3back" onClick={onClose}><BackIcon />Focus</button>
      <div className="t3dh"><h2 className="hero-title">{g.title}</h2><em className={`wrpill is-${pcls}`}>{plabel}</em></div>
      {done ? <p className="t3sub">{done}</p> : null}
      {inThree ? null : <p className="t3outside">Not one of your priority goals right now.</p>}
      <GoalHero g={g} />
      <Track g={g} onStarted={onChanged} />
      {g.why || g.scope ? (
        <details className="t3about"><summary>Why this goal</summary>
          {g.why ? <p className="t3why"><SparkIcon />{g.why}</p> : null}
          {g.scope ? <p className="t3scope"><span>Counts</span>{g.scope}</p> : null}
        </details>
      ) : null}
      {g.nextStep ? <section className="hsec"><h4>Next milestone</h4><p className="t3next">{g.nextStep}</p></section> : null}
      <section className="hsec"><h4>Moves it <em>{mine.length}</em></h4>
        {mine.length ? mine.map((t) => <TaskRow key={t.id} t={t} three={three} onToggled={onChanged} />) : <p className="t3sub">No tasks yet. Ask Pen for the next step.</p>}
      </section>
      <footer className="t3foot">
        <button type="button" className="hfocus-primary" onClick={() => chatAbout(g)}>Work on it with Pen</button>
        {inThree
          ? <button type="button" className="hfocus-ghost" onClick={() => onEdit(g.id)}>Edit goal</button>
          : <button type="button" className="hfocus-ghost" onClick={() => onPromote(g.id)}>Make it one of three</button>}
      </footer>
    </div>
  );
}
