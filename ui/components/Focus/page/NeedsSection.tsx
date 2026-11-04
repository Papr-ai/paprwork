/**
 * Needs you, inside the brief: the top item is the "Do this first" card; the rest are "Also needs you"
 * cards, then muted sources and Later. Same markup and classes the Home iframe drew (needs.js).
 */
import { useEffect, useState } from "react";
import type { FeedItem, FocusAck, FocusFeed } from "../focusBridge";
import { AgentIcon } from "./icons";

export type Run = (op: string, args: Record<string, unknown>) => Promise<FocusAck>;
export interface NeedsUi { run: (key: string, op: string, args: Record<string, unknown>, after?: () => void) => Promise<void>; busy: string | null; errors: Record<string, string>; drafts: Record<string, string>; setDraft: (id: string, v: string) => void }

const ini = (n: string) => String(n || "?").replace(/[@+].*$/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";

/** A person is always a pill: photo (initials if none or it fails to load) + name. */
export function Pill({ name, feed }: { name: string; feed: FocusFeed }) {
  const u = feed.avatars[name];
  const [ok, setOk] = useState(/^https:\/\//.test(u || ""));
  return <span className="hpill" title={name}><i className={ok ? "has-img" : ""}>{ok ? <img src={u} alt="" onError={() => setOk(false)} /> : null}{ini(name)}</i>{name}</span>;
}

/** "@amir+1 knows the copy" → the @name as a pill. Known full names first, then one token. */
export function Pills({ text, feed }: { text: string; feed: FocusFeed }) {
  const names = feed.people.slice().sort((a, b) => b.length - a.length);
  const re = new RegExp(`@(${[...names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "[\\p{L}\\p{N}._+-]+"].join("|")})`, "gu");
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index), <Pill key={m.index} name={m[1]} feed={feed} />);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

function Menu({ i, run, openKey, setOpen }: { i: FeedItem; run: NeedsUi["run"]; openKey: string | null; setOpen: (k: string | null) => void }) {
  const m = i.menu, open = openKey === i.key;
  const item = (op: string, label: string, sub: string, extra: Record<string, unknown> = {}) => (
    <button type="button" role="menuitem" onClick={() => { setOpen(null); void run(i.key, op, { key: i.key, ...extra }); }}>{label}{sub ? <em>{sub}</em> : null}</button>
  );
  return (
    <div className="hmenu">
      <button type="button" className="hmenu-dots" aria-label="Options" aria-expanded={open} onClick={() => setOpen(open ? null : i.key)}>&hellip;</button>
      {open ? (
        <div className="hmenu-pop" role="menu">
          {i.urgent ? <p>Always on: this reaches you until it&apos;s fixed.</p> : <>
            {item("later", "Later", `Back ${m.laterWhen}`)}
            {item("mute", `Mute ${m.source} for 1 hour`, "No desktop notifications, out of this list")}
            {m.focus ? <>{item("focus", `Always show ${m.source} in Focus`, "Right away, without waiting for Pen", { mode: "always" })}
              {item("focus", `Keep ${m.source} off Focus`, `Stays as a dot on ${m.source}`, { mode: "never" })}</> : null}
            {item("turnoff", `Turn off ${m.type}`, "")}
          </>}
          <button type="button" role="menuitem" className="is-link" onClick={() => { setOpen(null); void run(i.key, "settings", {}); }}>{m.source} notification settings</button>
        </div>
      ) : null}
    </div>
  );
}

/** Shared menu state: one open at a time; click outside or Escape closes it. */
export function useMenu() {
  const [openKey, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!openKey) return;
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".hmenu")) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [openKey]);
  return { openKey, setOpen };
}

export function NeedHero({ i, feed, ui, goal, menu }: { i: FeedItem; feed: FocusFeed; ui: NeedsUi; goal: string; menu: ReturnType<typeof useMenu> }) {
  const m = i.mention, busy = ui.busy === i.key, err = ui.errors[i.key];
  const kind = m?.took ? "In progress" : m ? "Asked of you" : "";
  const fromDup = !i.from || String(i.title).includes(String(i.from).replace(/\s*·.*$/, ""));
  const draft = m ? ui.drafts[m.itemId] ?? m.draft : "";
  const answer = (status: string) => {
    if (!m) return;
    const d = draft.trim();
    const reply = status === "open" ? d : status === "dismissed" && d && d !== m.draft ? d : undefined;
    if (status === "open" && !reply) return;
    void ui.run(i.key, "answer", { itemId: m.itemId, status, reply });
  };
  const P = (label: string, on: () => void, dis = false) => <button type="button" className="hfocus-primary" disabled={dis} onClick={on}>{label}</button>;
  const Q = (label: string, on: () => void, dis = false) => <button type="button" className="hfocus-ghost" disabled={dis} onClick={on}>{label}</button>;
  const later = () => void ui.run(i.key, "later", { key: i.key });
  const open = () => void ui.run(i.key, "open", { key: i.key });
  return (
    <section className={`hfocus hneed-hero${i.urgent ? " is-urgent" : ""}`}>
      <header><small>{i.urgent ? "You're blocked" : "Do this first"}</small>{goal ? <em className="hchip" title={`Moves ${goal}`}>{goal}</em> : null}
        <Menu i={i} run={ui.run} openKey={menu.openKey} setOpen={menu.setOpen} /></header>
      <h3>{i.title}</h3>
      {kind || (!m && !fromDup) ? (
        <span className="hneed-from"><b>{kind}</b>{m ? <><Pill name={i.from} feed={feed} />{m.when ? <span>{m.when}</span> : null}</> : <span>{i.from}</span>}</span>
      ) : null}
      {!m?.took && i.body ? <p>{m ? <Pills text={i.body} feed={feed} /> : i.body}</p> : null}
      {m && !m.took && m.ready ? (
        <label className="hdraft"><small>Pen drafted your reply</small>
          <textarea rows={2} value={draft} onChange={(e) => ui.setDraft(m.itemId, e.target.value)} /></label>
      ) : null}
      {err ? <p className="hneed-err" role="alert">{err}</p> : null}
      <div className="hfocus-acts">
        {m?.took ? <>{P("Done", () => answer("done"), busy)}{Q("Can't", () => answer("dismissed"), busy)}</>
          : m ? <>{P(busy ? "Sending…" : "I'm on it", () => answer("open"), busy || !m.ready)}{Q("Can't", () => answer("dismissed"), busy || !m.ready)}{Q("Later", later)}</>
          : <>{P(i.action, open)}{i.urgent ? null : Q("Later", later)}</>}
        {m ? Q("Open chat", open) : null}
      </div>
    </section>
  );
}

export function AlsoNeeds({ feed, ui, goalOf, menu }: { feed: FocusFeed; ui: NeedsUi; goalOf: (i: FeedItem) => string; menu: ReturnType<typeof useMenu> }) {
  const [more, setMore] = useState(false);
  const rest = feed.needs.slice(1), vis = more ? rest : rest.slice(0, 3);
  return (
    <>
      {rest.length ? (
        <section className="hsec halso"><h4>Also needs you <em>{rest.length}</em></h4>
          {vis.map((i) => {
            const m = i.mention, g = goalOf(i);
            const draft = m?.ready && !m.took ? String(ui.drafts[m.itemId] ?? m.draft ?? "").trim() : "";
            return (
              <article key={i.key} className={`hcard${i.urgent ? " is-urgent" : ""}`}>
                <div className="hcard-t">
                  <span className="hcard-meta"><b>{i.reason || i.menu.source}</b>{m ? <Pill name={i.from} feed={feed} /> : <span>{i.from}</span>}{g ? <em className="hchip" title={`Moves ${g}`}>{g}</em> : null}</span>
                  <h5>{i.title}</h5>
                  {draft ? <p className="hpen"><i className="hpen-mk"><AgentIcon /></i><span>Reply drafted: “{draft}”</span></p>
                    : i.body ? <p className="hcard-body">{m ? <Pills text={i.body} feed={feed} /> : i.body}</p> : null}
                </div>
                <div className="hcard-a">
                  <button type="button" className="hgo" onClick={() => void ui.run(i.key, "open", { key: i.key })}>{m ? "Reply" : i.action}</button>
                  {i.urgent ? null : <button type="button" className="hquiet" onClick={() => void ui.run(i.key, "later", { key: i.key })}>Later</button>}
                  <Menu i={i} run={ui.run} openKey={menu.openKey} setOpen={menu.setOpen} />
                </div>
              </article>
            );
          })}
          {rest.length > 3 ? <button type="button" className="t3link hneed-more" onClick={() => setMore(!more)}>{more ? "Show less" : `Show ${rest.length - 3} more`}</button> : null}
        </section>
      ) : null}
      {feed.muted.map((m) => (
        <p key={m.id} className="hneed-note"><span>{m.name} muted until {m.until}. Dots still show on the things.</span>
          <button type="button" className="t3link" onClick={() => void ui.run(m.id, "unmute", { sourceId: m.id })}>Unmute</button></p>
      ))}
      {feed.later.length ? (
        <section className="hsec"><h4>Later <em>{feed.later.length}</em></h4>
          {feed.later.map((l) => (
            <div key={l.key} className="hrow"><span className="hrt"><b>{l.title}</b><span>Back {l.when}</span></span>
              <button type="button" className="t3link" onClick={() => void ui.run(l.key, "unlater", { key: l.key })}>Bring back now</button></div>
          ))}
        </section>
      ) : null}
    </>
  );
}
