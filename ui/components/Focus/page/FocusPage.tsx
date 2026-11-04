/**
 * The Focus page, native. Same experience as the Home app it replaces: day stepper, Today | All tasks,
 * and full-page sub-views for a goal, Edit your three and the Monday review.
 */
import { useCallback, useEffect, useState } from "react";
import { askText } from "../../../../src/resources/mini-app-sdk/papr-dialog";
import { fmtDay, itemTitle, type BriefItem } from "./brief";
import { useBrief } from "./useBrief";
import { useFocusData } from "./useFocusData";
import { useFocusFeed } from "../focusBridge";
import { useNeedsUi } from "./useNeedsUi";
import { TodayView } from "./TodayView";
import { TasksView } from "./TasksView";
import { GoalDetail } from "./GoalDetail";
import { EditThree } from "./EditThree";
import { WeekReview } from "./WeekReview";
import { DayNextIcon, DayPrevIcon } from "./icons";
import { FOCUS_OPEN_GOAL_EVENT, takePendingFocusGoal } from "./focusNav";
import "../focusPage.css";

type Sub = { view: "goal" | "edit" | "review"; id?: string; own?: boolean; promote?: string } | null;

export function FocusPage() {
  const b = useBrief();
  const d = useFocusData();
  const { feed, run } = useFocusFeed();
  const { ui, toast, undo } = useNeedsUi(run);
  const [tab, setTab] = useState<"today" | "tasks">("today");
  const [sub, setSub] = useState<Sub>(null);
  const [turn, setTurn] = useState<"" | "turn-prev" | "turn-next" | "turn-in">("");

  const open = useCallback((view: "goal" | "edit" | "review", id?: string, opts?: { own?: boolean }) => {
    setSub({ view, id, own: opts?.own });
    document.querySelector(".fpage-shell")?.scrollTo?.(0, 0);
  }, []);
  const close = useCallback(() => { setSub(null); void d.reloadState(); void d.reloadGoals(); }, [d]);

  // Rail peek / nudge deep link: open one goal once its data is here.
  const [wanted, setWanted] = useState<string | null>(() => takePendingFocusGoal());
  useEffect(() => {
    const on = () => setWanted(takePendingFocusGoal());
    window.addEventListener(FOCUS_OPEN_GOAL_EVENT, on);
    return () => window.removeEventListener(FOCUS_OPEN_GOAL_EVENT, on);
  }, []);
  useEffect(() => {
    if (!wanted || !d.loaded) return;
    if (d.find(wanted)) { setTab("today"); open("goal", wanted); }
    setWanted(null);
  }, [wanted, d.loaded, d, open]);

  const onReview = useCallback(async (i: BriefItem, next: "complete" | "irrelevant" | "active") => {
    if (next !== "irrelevant") return void b.review(i, next);
    const t = itemTitle(i);
    const note = await askText(`Why is "${t}" irrelevant? Tomorrow's brief will use this to avoid similar items.`, "", i._review?.note || "", "Save");
    if (note) void b.review(i, "irrelevant", note);
  }, [b]);

  const step = async (dir: "prev" | "next") => {
    const next = dir === "prev" ? b.idx + 1 : b.idx - 1;
    if (turn || next < 0 || next >= b.dates.length) return;
    setTurn(dir === "prev" ? "turn-prev" : "turn-next");
    await new Promise((r) => setTimeout(r, 180));
    b.setIdx(next); setTurn("turn-in");
    setTimeout(() => setTurn(""), 240);
  };

  const g = sub?.view === "goal" && sub.id ? d.find(sub.id) : null;
  const canPrev = b.idx < b.dates.length - 1, canNext = b.idx > 0;
  const peek = (i: number) => (b.dates[i] ? fmtDay(b.dates[i]) : "");

  return (
    <div className="fpage-shell" data-testid="focus-page">
      <main className={`fpage home${turn ? ` ${turn}` : ""}`}>
        <div className={`htop${sub ? " is-sub" : ""}`}>
          <div className={`hday${tab === "today" ? "" : " is-hidden"}`} aria-label="Brief day">
            <button className={`hday-btn${canPrev ? "" : " disabled"}`} aria-label="Previous day" title={canPrev ? peek(b.idx + 1) : ""} onClick={() => void step("prev")}><DayPrevIcon /></button>
            <span className="hday-label">{b.idx === 0 ? "Today" : peek(b.idx)}</span>
            <button className={`hday-btn${canNext ? "" : " disabled"}`} aria-label="Next day" title={canNext ? peek(b.idx - 1) : ""} onClick={() => void step("next")}><DayNextIcon /></button>
          </div>
          <div className="hseg" role="tablist" aria-label="Focus view">
            <button type="button" role="tab" className={tab === "today" ? "on" : ""} aria-selected={tab === "today"} onClick={() => setTab("today")}>Today</button>
            <button type="button" role="tab" className={tab === "tasks" ? "on" : ""} aria-selected={tab === "tasks"} onClick={() => { setTab("tasks"); void d.reloadTasks(); }}>
              All tasks <em>{d.tasks?.counts?.open || ""}</em>
            </button>
          </div>
        </div>

        {sub?.view === "goal" && g ? (
          <div id="view-three"><GoalDetail g={g} three={d.three} tasks={d.tasks?.tasks ?? []} onClose={close}
            onEdit={(id) => open("edit", id)} onPromote={(id) => setSub({ view: "edit", promote: id })}
            onChanged={() => { void d.reloadTasks(); void d.reloadState(); }} /></div>
        ) : sub?.view === "edit" ? (
          <div id="view-three"><EditThree data={d.state} focusId={sub.id} promoteId={sub.promote} startOwn={sub.own} onSaved={d.setState} onClose={close} /></div>
        ) : sub?.view === "review" && d.state?.three?.length ? (
          <div id="view-three"><WeekReview data={d.state} onClose={close} onChange={() => setSub({ view: "edit" })} onSaved={d.setState} /></div>
        ) : tab === "tasks" ? (
          <div id="view-tasks"><TasksView data={d.tasks} three={d.three} onChanged={() => void d.reloadTasks()} /></div>
        ) : (
          <TodayView b={b} d={d} feed={feed} ui={ui} onReview={(i, n) => void onReview(i, n)} open={open} />
        )}
      </main>
      {toast ? (
        <div className="hneed-toast" role="status"><span>{toast.text}</span>{toast.undo ? <button type="button" onClick={undo}>Undo</button> : null}</div>
      ) : null}
    </div>
  );
}
