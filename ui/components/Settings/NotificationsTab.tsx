/**
 * Settings → Notifications. Your changes sit on top of Papr's defaults: anything you
 * leave alone follows the defaults as they improve, and Reset drops all your changes.
 * Nothing ever pops while Paprwork is in front; these settings are about when it isn't.
 */
import { useCallback, useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";
import "./NotificationsTab.css";

type AppPref = "all" | "mentions" | "off";
interface Prefs { priorityOs: boolean; priorityEmail: boolean; chatDoneOs: boolean; apps?: Record<string, AppPref> }
interface Recent { title: string; source: string; level: string; status: "sent" | "capped"; why: string[]; at: string }
interface Center { prefs: Prefs; defaults: Prefs; apps: { id: string; name: string }[]; recent: Recent[] }

const APP_LABEL: Record<AppPref, string> = { all: "Everything", mentions: "Only what's for me", off: "Off" };

function changed(c: Center): boolean {
  const { prefs: p, defaults: d } = c;
  return p.priorityOs !== d.priorityOs || p.chatDoneOs !== d.chatDoneOs || Object.keys(p.apps ?? {}).length > 0;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function NotificationsTab() {
  const [c, setC] = useState<Center | null>(null);
  const [error, setError] = useState("");

  const call = useCallback(async (type: string, payload?: Record<string, unknown>) => {
    try {
      const res = await gateway.send(type, payload);
      if (res.success) { setC(res.data as Center); setError(""); } else setError(res.error ?? "Couldn't save");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach Paprwork's background service");
    }
  }, []);

  useEffect(() => { void call("notifications:center"); }, [call]);
  const set = (prefs: Partial<Prefs>) => void call("notifications:set-prefs", { prefs });

  if (!c) {
    return <div className="settings-content"><div className="settings-section">{error || "Loading…"}</div></div>;
  }
  const appPref = (id: string): AppPref => c.prefs.apps?.[id] ?? "mentions";

  return (
    <div className="settings-content notif-settings">
      <div className="settings-section">
        <h2 className="settings-section__title">Notifications</h2>
        <p className="settings-section__description">
          While you're in Paprwork you only see dots. These decide what pops on your desktop when you're not.
        </p>
        <SettingRow label="Things that need you" hint="A key Pen asked for, a job waiting on you, a proposal to review, an update ready.">
          <Toggle checked={c.prefs.priorityOs} onChange={(v) => set({ priorityOs: v })} ariaLabel="Desktop notifications for things that need you" />
        </SettingRow>
        <SettingRow label="Pen finished a reply" hint="Silent. Only for chats you aren't looking at.">
          <Toggle checked={c.prefs.chatDoneOs} onChange={(v) => set({ chatDoneOs: v })} ariaLabel="Desktop notification when a reply finishes" />
        </SettingRow>
        <SettingRow label="Urgent" hint="Something stopped working for you, like billing or your account. Only Papr can send these.">
          <span className="notif-settings__fixed">Always on</span>
        </SettingRow>
        <p className="notif-settings__note">No app or sender can pop more than 5 times in 10 minutes. The rest wait as dots.</p>
      </div>

      <div className="settings-section">
        <h2 className="settings-section__title">Apps</h2>
        {c.apps.length === 0 ? (
          <p className="settings-section__description">Apps that send you notifications show up here.</p>
        ) : (
          c.apps.map((a) => (
            <SettingRow key={a.id} label={a.name}>
              <select className="notif-settings__select" value={appPref(a.id)} aria-label={`Notifications from ${a.name}`}
                onChange={(e) => set({ apps: { ...c.prefs.apps, [a.id]: e.target.value as AppPref } })}>
                {(Object.keys(APP_LABEL) as AppPref[]).map((k) => <option key={k} value={k}>{APP_LABEL[k]}</option>)}
              </select>
            </SettingRow>
          ))
        )}
      </div>

      <div className="settings-section">
        <h2 className="settings-section__title">Recent</h2>
        {c.recent.length === 0 ? (
          <p className="settings-section__description">Nothing has popped yet.</p>
        ) : (
          <ul className="notif-settings__recent">
            {c.recent.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <details>
                  <summary>
                    <span className="notif-settings__title">{r.title}</span>
                    <span className="notif-settings__meta">
                      {r.source} · {r.status === "sent" ? "shown" : "held back"} · {when(r.at)}
                    </span>
                  </summary>
                  <ul className="notif-settings__why">{r.why.map((w) => <li key={w}>{w}</li>)}</ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="notif-settings__footer">
        {error && <span className="notif-settings__error">{error}</span>}
        {changed(c) ? (
          <button type="button" className="btn btn--secondary" onClick={() => void call("notifications:reset-prefs")}>Reset to defaults</button>
        ) : (
          <span className="notif-settings__fixed">Using Papr's defaults</span>
        )}
      </div>
    </div>
  );
}
