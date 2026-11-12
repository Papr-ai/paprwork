/**
 * All tasks (the Today | All tasks switch) and the task row the goal page reuses. Port of tasks.js.
 * Checking a box edits the source markdown through the done endpoint, so every agent sees it.
 */
import { useState } from "react";
import { focusApi, type FocusGoal, type Task, type TasksResult } from "./focusApi";
import { goalLabel, taskDue } from "./fmt";
import { TaskCheckIcon } from "./icons";

export function TaskRow({ t, three, onToggled }: { t: Task; three: FocusGoal[]; onToggled: () => void }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const done = pending ?? t.status === "done";
  const entity = t.entity_ref ? t.entity_ref.split("/").pop()!.replace(/-/g, " ") : "";
  const meta = [taskDue(t.due), entity].filter(Boolean).join(" · ");
  const owner = t.owner && !/^(me|user|you|self)$/i.test(t.owner) ? t.owner : "";
  // Tag by goal name when it's one of your three; anything else stays a quiet grey code.
  const lab = goalLabel(three, t.goal_id);
  const toggle = async () => {
    const next = !done;
    setPending(next);
    await focusApi.setTaskDone(t.id, next).catch(() => undefined);
    onToggled();
    setPending(null);
  };
  return (
    <div className={`hrow${done ? " done" : ""}`}>
      <button type="button" className="hchk" disabled={pending !== null} aria-label={done ? "Reopen" : "Mark done"} onClick={() => void toggle()}>
        <TaskCheckIcon />
      </button>
      <div className="hrt"><b>{t.title}</b>{meta ? <span>{meta}</span> : null}</div>
      {owner ? <em className="hk">{owner}</em> : null}
      {t.goal_id ? (
        <span className={`hg${lab ? " on" : ""}`} title={lab ? `Priority goal: ${three.find((g) => g.id === t.goal_id)?.title ?? ""}` : "Not a priority goal"}>
          {lab || t.goal_id}
        </span>
      ) : null}
    </div>
  );
}

export function TasksView({ data, three, onChanged }: { data: TasksResult | null; three: FocusGoal[]; onChanged: () => void }) {
  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done").slice(0, 20);
  if (!open.length && !done.length) {
    return (
      <section className="hempty">
        <b>No tasks yet</b>
        <p>Tasks come from your goals&apos; tactical steps and the Open Items on your wiki pages. Confirm goals on Today, or ask your agent to add one.</p>
      </section>
    );
  }
  const group = (title: string, items: Task[]) =>
    items.length ? (
      <section className="hsec">
        <h4>{title}<em>{items.length}</em></h4>
        {items.map((t) => <TaskRow key={t.id} t={t} three={three} onToggled={onChanged} />)}
      </section>
    ) : null;
  return (
    <>
      <h2 className="hero-title">All tasks</h2>
      <p className="hero-stats">
        <span className="stat"><b className="stat-num">{open.length}</b> <span className="stat-label">open</span></span>
        <span className="stat"><b className="stat-num">{data?.counts?.done ?? 0}</b> <span className="stat-label">done</span></span>
      </p>
      {group("Open", open)}
      {group("Recently done", done)}
    </>
  );
}
