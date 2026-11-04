/**
 * Needs you: the top of Focus. What's waiting on you that has no other home, plus what was promoted
 * off its dot (with the reason). One list. The first is a card with its one
 * fix; the rest are rows. Each has a … menu: Later, Mute this source for an hour, Turn off this type,
 * and its settings. Urgent can't be put off or muted. Later items sit in a quiet list below, and a
 * muted source shows one line with Unmute. Nothing at all when empty.
 */
import { useState } from "react";
import type { Notice } from "../../../src/core/types/notices";
import { hasFocusMode, isUrgent, laterUntil, muteEndLabel, noticeLabels, whenLabel } from "../../../src/core/notifications/needsYou";
import { sourceDef } from "../../../src/core/notifications/sources";
import { openNoticeOwner } from "../../stores/noticeOs";
import { ensureSettingsTab } from "../../lib/ensureSettingsTab";
import { bringBack, muteSource, putOff, setFocusMode, turnOffType, unmuteSource, useNeedsYou } from "../../stores/useNeedsYou";
import { NeedsYouMenu } from "./NeedsYouMenu";
import { useNoticeStore } from "../../stores/noticeStore";
import "./NeedsYou.css";

const MAX_ROWS = 4;
type Toast = { text: string; undo: () => void } | null;

/** The one filled button: the fix if the notice has one, else Open. Both go to the thing. */
const actionLabel = (n: Notice) => (n.actions ?? []).find((a) => a.intent !== "open")?.label ?? n.actions?.[0]?.label ?? "Open";

export function NeedsYou() {
  const { needs, reasons, later, muted } = useNeedsYou();
  const offline = useNoticeStore((s) => s.notices.find((n) => n.key === "net.offline") ?? null);
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const flash = (t: Toast) => { setToast(t); if (t) window.setTimeout(() => setToast((c) => (c === t ? null : c)), 6000); };

  const onLater = (n: Notice) => { void putOff(n.key); flash({ text: `Back ${whenLabel(laterUntil())}`, undo: () => void bringBack(n.key) }); };
  const onMute = (id: string, name: string) => {
    void muteSource(id).then((r) => flash({ text: `${name} muted until ${r?.until ? muteEndLabel(r.until) : "in an hour"}`, undo: () => void unmuteSource(id) }));
  };
  const onFocus = (id: string, name: string, mode: "always" | "never") => {
    void setFocusMode(id, mode);
    flash({ text: mode === "always" ? `${name} always shows in Focus` : `${name} stays as dots`, undo: () => void setFocusMode(id, "pen") });
  };
  const menu = (n: Notice) => {
    const l = noticeLabels(n);
    const focus = hasFocusMode(l.sourceId) ? { always: () => onFocus(l.sourceId, l.source, "always"), never: () => onFocus(l.sourceId, l.source, "never") } : undefined;
    return <NeedsYouMenu urgent={isUrgent(n)} source={l.source} type={l.type} laterWhen={whenLabel(laterUntil())}
      onLater={() => onLater(n)} onMute={() => onMute(l.sourceId, l.source)} onTurnOff={() => void turnOffType(l.sourceId, l.typeId)}
      onSettings={() => ensureSettingsTab({ section: "notifications" })} focus={focus} />;
  };
  const open = (n: Notice) => openNoticeOwner(n.owner, n.key);
  const [first, ...rest] = needs;
  const shown = more ? rest : rest.slice(0, MAX_ROWS);
  // Nothing waiting, nothing put off, nothing muted: no section at all (an empty box is just noise).
  if (!first && !later.length && !muted.length && !toast && !offline) return null;

  return (
    <section className="needs-you" aria-label="Needs you">
      {offline ? <p className="needs-you__ambient" role="status"><i aria-hidden="true" /><b>{offline.title}.</b> {offline.body}</p> : null}
      <h2 className="needs-you__h">Needs you{needs.length ? <em>{needs.length}</em> : null}</h2>
      {first ? (
        <article className={`needs-you__hero${isUrgent(first) ? " is-urgent" : ""}`}>
          <header><small>{isUrgent(first) ? "You're blocked" : "Do this first"}</small><span className="needs-you__from">{first.owner.name}{reasons[first.key] ? ` · ${reasons[first.key]}` : ""}</span>{menu(first)}</header>
          <h3>{first.title}</h3>
          {first.body ? <p>{first.body}</p> : null}
          <footer><button type="button" className="needs-you__go" onClick={() => open(first)}>{actionLabel(first)}</button></footer>
        </article>
      ) : null}
      {shown.length ? (
        <div className="needs-you__list">
          {shown.map((n) => (
            <div key={n.key} className="needs-you__row">
              <i className="needs-you__dot" aria-hidden="true" />
              <div className="needs-you__rt"><b>{n.title}</b><span className="needs-you__from">{n.owner.name}{reasons[n.key] ? ` · ${reasons[n.key]}` : ""}</span></div>
              <button type="button" className="needs-you__go is-small" onClick={() => open(n)}>{actionLabel(n)}</button>
              {menu(n)}
            </div>
          ))}
        </div>
      ) : null}
      {rest.length > MAX_ROWS ? (
        <button type="button" className="needs-you__more" onClick={() => setMore(!more)}>{more ? "Show less" : `Show ${rest.length - MAX_ROWS} more`}</button>
      ) : null}
      {muted.map((m) => (
        <p key={m.id} className="needs-you__muted">
          <span>{sourceDef(m.id)?.name ?? "This source"} muted until {muteEndLabel(m.until)}. Dots still show on the things.</span>
          <button type="button" onClick={() => void unmuteSource(m.id)}>Unmute</button>
        </p>
      ))}
      {later.length ? (
        <div className="needs-you__later">
          <h4>Later<em>{later.length}</em></h4>
          {later.map((n) => (
            <div key={n.key} className="needs-you__lrow">
              <span className="needs-you__when">{whenLabel(n.laterUntil!)}</span><b>{n.title}</b>
              <button type="button" onClick={() => void bringBack(n.key)}>Bring back now</button>
            </div>
          ))}
        </div>
      ) : null}
      {toast ? (
        <div className="needs-you__toast" role="status"><span>{toast.text}</span>
          <button type="button" onClick={() => { toast.undo(); setToast(null); }}>Undo</button></div>
      ) : null}
    </section>
  );
}
