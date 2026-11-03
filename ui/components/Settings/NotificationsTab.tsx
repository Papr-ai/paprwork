/**
 * Settings → Notifications: a list of sources (Papr Work's own, then apps), like iOS. Open one to
 * choose where each kind of notice appears. Your changes sit on top of Papr's defaults: anything you
 * leave alone follows the defaults as they improve, and Reset drops all your changes. Urgent (billing,
 * your account) is Always on and has no setting. Nothing pops while Papr Work is in front.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { NOTICES_CHANGED_EVENT, type Notice } from "../../../src/core/types/notices";
import { appSourceId, type NoticeSourceDef } from "../../../src/core/notifications/sources";
import { SURFACES, sourcePref, type NoticePrefs, type SourcePref } from "../../../src/core/notifications/prefs";
import { NotificationSourcePage, SURFACE_LABEL, type Patch } from "./NotificationSourcePage";
import { NotificationsTop } from "./NotificationsTop";
import "./NotificationsTab.css";

interface Center { prefs: NoticePrefs; sources: NoticeSourceDef[]; apps: { id: string; name: string }[] }

const APP_TYPES = [{ id: "app.notification", label: "Notifications from this app", chip: "Notifications", cat: "needs" as const }];
const changed = (p: NoticePrefs) => Object.keys(p.sources).length > 0 || Object.keys(p.types).length > 0 || !!p.previews;

/** "Desktop, Badges · Done: Badges": what this source does, from the rows it has. */
function summary(src: NoticeSourceDef, p: SourcePref): string {
  if (!p.allow) return "Off";
  const part = (c: "needs" | "done") => SURFACES.filter((k) => p[c][k]).map((k) => SURFACE_LABEL[k][0]).join(", ") || "Off";
  const has = (c: string) => src.types.some((t) => t.cat === c);
  if (has("needs") && has("done")) return `Waiting: ${part("needs")} · Done: ${part("done")}`;
  return part(has("needs") ? "needs" : "done");
}

export function NotificationsTab() {
  const [c, setC] = useState<Center | null>(null);
  const [open, setOpen] = useState("");
  const [error, setError] = useState("");

  const call = useCallback(async (type: string, payload?: Record<string, unknown>) => {
    try {
      const res = await gateway.send(type, payload);
      if (res.success) { setC(res.data as Center); setError(""); } else setError(res.error ?? "Couldn't save");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach Papr Work's background service");
    }
  }, []);
  useEffect(() => { void call("notifications:center"); }, [call]);
  // An app that sends its first notification while this page is open gets its row right away.
  const knownApps = useRef(new Set<string>());
  knownApps.current = new Set(c?.apps.map((a) => a.id) ?? []);
  useEffect(() => {
    const onBroadcast = (event: Event) => {
      const { type, data } = (event as CustomEvent<{ type?: string; data?: { notices?: Notice[] } }>).detail ?? {};
      if (type !== NOTICES_CHANGED_EVENT || !Array.isArray(data?.notices)) return;
      if (data.notices.some((n) => n.source.type === "app" && !knownApps.current.has(appSourceId(n.source.id)))) void call("notifications:center");
    };
    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, [call]);
  const set = (prefs: Patch & { previews?: string }) => void call("notifications:set-prefs", { prefs });

  if (!c) return <div className="settings-content"><div className="settings-section">{error || "Loading…"}</div></div>;
  const apps: NoticeSourceDef[] = c.apps.map((a) => ({ id: a.id, name: a.name, desc: "Mini-app", types: APP_TYPES }));
  const current = [...c.sources, ...apps].find((s) => s.id === open);
  const rows = (xs: NoticeSourceDef[]) => xs.map((s) => (
    <button key={s.id} type="button" className="notif-row" onClick={() => setOpen(s.id)}>
      <span className="notif-row__tile">{s.name.slice(0, 1)}</span>
      <span className="notif-row__text"><b>{s.name}</b><small>{summary(s, sourcePref(c.prefs, s.id))}</small></span>
      <span className="notif-row__chev" aria-hidden="true">&rsaquo;</span>
    </button>
  ));

  return (
    <div className="settings-content notif-settings">
      {current ? <NotificationSourcePage src={current} prefs={c.prefs} onSet={set} onBack={() => setOpen("")} /> : (
        <div className="settings-section">
          <h2 className="settings-section__title">Notifications</h2>
          <p className="settings-section__description">
            While you're in Papr Work you only see dots: blue when something's waiting on you, green when it's done.
            Choose, for each source, what reaches you when you're not.
          </p>
          <NotificationsTop prefs={c.prefs} onSet={set} />
          <h3 className="notif-settings__h">Papr Work</h3>
          <div className="notif-group">{rows(c.sources)}</div>
          <h3 className="notif-settings__h">Apps</h3>
          {apps.length ? <div className="notif-group">{rows(apps)}</div>
            : <p className="settings-section__description">Apps that send you notifications show up here.</p>}
          <p className="notif-settings__note">
            Urgent (billing, your account) is always on: Papr Work is stopped until it's fixed. No source can pop more than 5 times in 10 minutes.
          </p>
        </div>
      )}

      <div className="notif-settings__footer">
        {error && <span className="notif-settings__error">{error}</span>}
        {changed(c.prefs)
          ? <button type="button" className="btn btn--secondary" onClick={() => void call("notifications:reset-prefs")}>Reset to defaults</button>
          : <span className="notif-settings__fixed">Using Papr's defaults</span>}
      </div>
    </div>
  );
}
