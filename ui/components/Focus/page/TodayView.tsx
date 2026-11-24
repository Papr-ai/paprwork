/**
 * Today: banners + hero, Monday review, then ONE plan (the brief's priorities with the asks Pen + Jev
 * placed today; Pen-is-blocked items pinned on top), Your three, Updates, the brief's other sections, Goals.
 * Asks not in the plan and Waiting on live in All tasks; Today links there.
 */
import { pickWaiting, todayKey } from "./brief";
import { focusEnv } from "./focusApi";
import { BriefHero, LoadErrorBanner, OfflineLine, SampleBanner, StaleBanner } from "./BriefBanners";
import { BriefSection, type OnReview } from "./BriefCards";
import { YourThree } from "./YourThree";
import { ReviewBanner, reviewDue } from "./WeekReview";
import { AlsoNeeds, NeedHero, useMenu, type NeedsUi } from "./NeedsSection";
import { GoalsEmpty, GoalsTree } from "./GoalsTree";
import { goalFor } from "./useNeedsUi";
import { onePlan, pickPlan, unplanned } from "./asks";
import { MoreAsks, PlanRest, PlanTop } from "./PlanSection";
import type { useBrief } from "./useBrief";
import type { FocusData } from "./useFocusData";
import type { FocusFeed } from "../focusBridge";

interface Props {
  b: ReturnType<typeof useBrief>; d: FocusData; feed: FocusFeed; ui: NeedsUi; onReview: OnReview;
  open: (view: "goal" | "edit" | "review", id?: string, opts?: { own?: boolean }) => void;
  openAsks: () => void;
}

export function TodayView({ b, d, feed, ui, onReview, open, openAsks }: Props) {
  const menu = useMenu();
  const today = b.idx === 0;
  const brief = b.brief;
  if (!brief && !b.error) return <p className="fpage-loading">Loading today&apos;s brief…</p>;
  // The brief's Waiting On moved to All tasks → You're waiting on. Past days keep it as written.
  const { sections: noWait } = today ? pickWaiting(brief?.sections ?? []) : { sections: brief?.sections ?? [] };
  const { priorities, sections } = pickPlan(noWait);
  const plan = onePlan(priorities, today ? feed.asks : [], brief?.date && !brief.stale ? brief.date : todayKey());
  // Pen can't go on until you act (an approval, a key): pinned above the plan.
  const blockers = today ? feed.needs.filter((n) => n.urgent) : [];
  // Notices that aren't asks (asks are ranked into the plan / All tasks) and aren't blockers.
  const updates = today ? feed.needs.filter((n) => !n.urgent && !n.mention) : [];
  const more = today ? unplanned(feed.asks, plan) : [];
  const hasThree = !!d.three.length;

  const goals = () => {
    if (!today || !d.goals) return null;
    if (d.goals.isEmpty) {
      // "What are you working toward?" would contradict the three shown above.
      if (hasThree) return null;
      return <GoalsEmpty onWrite={() => open("edit", undefined, { own: true })}
        onDraft={async () => { const s = await d.reloadState(); const ok = !!s?.three?.length; if (ok) open("edit"); return ok; }} />;
    }
    const tree = <GoalsTree data={d.goals} canOpen={(id) => !!d.find(id)} onOpen={(id) => open("goal", id)} onChanged={() => void d.reloadGoals()} />;
    // With Your three set, the full tree folds away under "All goals" so it never competes.
    return hasThree ? <details className="goals-all"><summary>All goals <em>{d.goals.goals.length}</em></summary>{tree}</details> : tree;
  };

  return (
    <div id="view-today">
      <header className="hero">
        {focusEnv.web ? null : <OfflineLine />}
        {b.error ? <LoadErrorBanner message={b.error} />
          : b.isSample ? <SampleBanner busy={b.generating} onGenerate={() => void b.generate()} />
          : brief?.stale && today ? <StaleBanner date={brief.date} busy={b.generating} onGenerate={() => void b.generate()} /> : null}
        {brief ? <BriefHero hero={brief.hero} live={today && !b.isSample ? { need: plan.length + blockers.length, waiting: feed.waiting.length, later: feed.later.length } : null} /> : null}
      </header>
      {today && reviewDue(d.state) ? <div id="review"><ReviewBanner onOpen={() => open("review")} /></div> : null}
      {blockers.map((i) => <NeedHero key={i.key} i={i} feed={feed} ui={ui} goal={goalFor(i, d.three)} menu={menu} />)}
      {plan[0] ? <PlanTop top={plan[0]} feed={feed} ui={ui} menu={menu} onReview={onReview} /> : null}
      <PlanRest rest={plan.slice(1)} feed={feed} ui={ui} onReview={onReview} />
      {today ? <MoreAsks asks={more} onOpen={openAsks} /> : null}
      {today ? <YourThree data={d.state} onOpen={(id) => open("goal", id)} onEdit={() => open("edit")} /> : null}
      {today ? <AlsoNeeds items={updates} feed={feed} ui={ui} goalOf={(i) => goalFor(i, d.three)} menu={menu} /> : null}
      <div id="sections">{sections.map((s) => <BriefSection key={`${s.type}-${s.title}`} s={s} onReview={onReview} />)}</div>
      <div id="goals">{goals()}</div>
    </div>
  );
}
