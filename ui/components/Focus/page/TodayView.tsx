/**
 * Today, in the Focus proposal's order: banners + hero, Monday review, Do this first (top need, else the
 * brief's top priority), Your three, Also needs you, Waiting on, the brief's sections, Goals.
 */
import { agentPrompt, pickFocus, pickWaiting, type BriefItem } from "./brief";
import { focusEnv, openChat } from "./focusApi";
import { ArrowIcon, CheckIcon } from "./icons";
import { BriefHero, LoadErrorBanner, OfflineLine, SampleBanner, StaleBanner } from "./BriefBanners";
import { BriefSection, type OnReview } from "./BriefCards";
import { YourThree } from "./YourThree";
import { ReviewBanner, reviewDue } from "./WeekReview";
import { AlsoNeeds, NeedHero, useMenu, type NeedsUi } from "./NeedsSection";
import { WaitingSection } from "./WaitingSection";
import { GoalsEmpty, GoalsTree } from "./GoalsTree";
import { goalFor } from "./useNeedsUi";
import type { useBrief } from "./useBrief";
import type { FocusData } from "./useFocusData";
import type { FocusFeed } from "../focusBridge";

interface Props {
  b: ReturnType<typeof useBrief>; d: FocusData; feed: FocusFeed; ui: NeedsUi; onReview: OnReview;
  open: (view: "goal" | "edit" | "review", id?: string, opts?: { own?: boolean }) => void;
}

export function TodayView({ b, d, feed, ui, onReview, open }: Props) {
  const menu = useMenu();
  const today = b.idx === 0;
  const brief = b.brief;
  if (!brief && !b.error) return <p className="fpage-loading">Loading today&apos;s brief…</p>;
  const { focus, sections: all } = brief ? pickFocus(brief.sections) : { focus: null as BriefItem | null, sections: [] };
  // Today: the brief's Waiting on folds into the live one (one heading). Past days keep it as written.
  const { notes, sections } = today ? pickWaiting(all) : { notes: null, sections: all };
  const needHero = today && feed.needs.length ? feed.needs[0] : null;
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
        {brief ? <BriefHero hero={brief.hero} live={today && !b.isSample ? { need: feed.needs.length, waiting: feed.waiting.length, later: feed.later.length } : null} /> : null}
      </header>
      {today && reviewDue(d.state) ? <div id="review"><ReviewBanner onOpen={() => open("review")} /></div> : null}
      {needHero ? <NeedHero i={needHero} feed={feed} ui={ui} goal={goalFor(needHero, d.three)} menu={menu} />
        : focus ? (
          <section className="hfocus"><header><small>Do this first</small></header>
            <h3>{focus.title}</h3>{focus.why ? <p>{focus.why}</p> : null}
            <div className="hfocus-acts">
              <button type="button" className="hfocus-primary" onClick={() => openChat(agentPrompt(focus))}>Start in chat <ArrowIcon /></button>
              <button type="button" className="hfocus-ghost" onClick={() => onReview(focus, "complete")}><CheckIcon />Mark done</button>
            </div>
          </section>
        ) : null}
      {today ? <YourThree data={d.state} onOpen={(id) => open("goal", id)} onEdit={() => open("edit")} /> : null}
      {today ? <AlsoNeeds feed={feed} ui={ui} goalOf={(i) => goalFor(i, d.three)} menu={menu} /> : null}
      {today ? <WaitingSection feed={feed} ui={ui} notes={notes} onReview={onReview} /> : null}
      <div id="sections">{sections.map((s) => <BriefSection key={`${s.type}-${s.title}`} s={s} onReview={onReview} />)}</div>
      <div id="goals">{goals()}</div>
    </div>
  );
}
