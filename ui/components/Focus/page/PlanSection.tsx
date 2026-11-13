/**
 * Today's one plan: the brief's priorities with the asks Pen + Jev placed today, in Jev's order.
 * The first item is "Do this first" (an ask shows its reply card there); the rest are numbered rows.
 * Asks not in the plan are one quiet line that opens All tasks → Asked of you.
 */
import { agentPrompt, type BriefItem } from "./brief";
import { openChat } from "./focusApi";
import { ArrowIcon, CheckIcon } from "./icons";
import { BriefCards, type OnReview } from "./BriefCards";
import { NeedHero, Pill, type NeedsUi, type useMenu } from "./NeedsSection";
import type { FeedItem, FocusFeed } from "../focusBridge";
import { WHEN_LABEL, type FeedAsk, type PlanItem } from "./asks";

/** An ask, in the shape the reply card takes (its notice when there is one, so Later / the menu work). */
export function askItem(a: FeedAsk, feed: FocusFeed): FeedItem {
  const n = feed.needs.find((x) => x.key === a.key);
  if (n) return n;
  return {
    key: a.key, goal: a.goal ?? null, urgent: false, title: a.title, body: a.text, from: a.fromName, reason: "Asked of you", action: "Reply",
    menu: { source: "People", type: "mentions", focus: false, laterWhen: "" },
    mention: { itemId: a.id, ready: true, took: a.took, draft: a.draft, when: a.due ? `due ${a.due}` : "" },
  };
}

function BriefHeroCard({ i, onReview }: { i: BriefItem; onReview: OnReview }) {
  return (
    <section className="hfocus"><header><small>Do this first</small></header>
      <h3>{i.title}</h3>{i.why ? <p>{i.why}</p> : null}
      <div className="hfocus-acts">
        <button type="button" className="hfocus-primary" onClick={() => openChat(agentPrompt(i))}>Start in chat <ArrowIcon /></button>
        <button type="button" className="hfocus-ghost" onClick={() => onReview(i, "complete")}><CheckIcon />Mark done</button>
      </div>
    </section>
  );
}

export function PlanTop({ top, feed, ui, menu, onReview }: { top: PlanItem; feed: FocusFeed; ui: NeedsUi; menu: ReturnType<typeof useMenu>; onReview: OnReview }) {
  if (top.kind === "brief") return <BriefHeroCard i={top.item} onReview={onReview} />;
  const i = askItem(top.ask, feed);
  return <NeedHero i={i} feed={feed} ui={ui} goal={top.ask.goal ?? ""} menu={menu} why={top.ask.why} />;
}

/** Plan items 2+, numbered. Asks show who asked and Pen's one-line why; Reply opens the card in chat. */
export function PlanRest({ rest, feed, ui, onReview }: { rest: PlanItem[]; feed: FocusFeed; ui: NeedsUi; onReview: OnReview }) {
  if (!rest.length) return null;
  return (
    <section className="hsec hplan"><h4>Then</h4>
      {rest.map((p, k) => p.kind === "brief"
        ? <BriefCards key={p.item._id} s={{ type: "priorities", title: "Then", items: [{ ...p.item, rank: k + 2 }] }} onReview={onReview} />
        : (
          <div key={p.ask.id} className="card hplan-ask">
            <div className="pri-head"><span className="pri-rank">{k + 2}</span>
              <div className="pri-body">
                <div className="pri-title">{p.ask.title}</div>
                <div className="hplan-meta"><Pill name={p.ask.fromName} feed={feed} />{p.ask.why ? <span>{p.ask.why}</span> : null}</div>
              </div>
              <button type="button" className="hgo" onClick={() => void ui.run(p.ask.key, "open", { key: p.ask.key, chatId: p.ask.chatId })}>Reply</button>
            </div>
          </div>
        ))}
    </section>
  );
}

/** "3 more asks · 1 today" → All tasks, filtered to Asked of you. */
export function MoreAsks({ asks, onOpen }: { asks: FeedAsk[]; onOpen: () => void }) {
  if (!asks.length) return null;
  const counts = (["now", "today", "this_week", "fyi"] as const).map((w) => [w, asks.filter((a) => a.when === w).length] as const).filter(([, n]) => n);
  const ranking = asks.filter((a) => !a.when).length;
  const bits = [...counts.map(([w, n]) => `${n} ${WHEN_LABEL[w].toLowerCase()}`), ...(ranking ? [`${ranking} being checked`] : [])];
  return (
    <button type="button" className="hneed-note hplan-more" onClick={onOpen}>
      <span><b>{asks.length} {asks.length === 1 ? "ask" : "asks"} not in today&apos;s plan</b>{bits.length ? ` · ${bits.join(" · ")}` : ""}</span>
      <span className="t3link">Asked of you <ArrowIcon /></span>
    </button>
  );
}
