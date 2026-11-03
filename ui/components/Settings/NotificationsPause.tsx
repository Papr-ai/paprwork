/**
 * Top of Settings → Notifications: Do Not Disturb (pause desktop notifications for a while; dots and
 * Urgent still come through) and a one-line "this week" count, so you can see how much reaches you.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { pausedAt, type NoticePrefs } from "../../../src/core/notifications/prefs";
import { SettingRow } from "./SettingRow";
import type { Patch } from "./NotificationSourcePage";

interface Stats { perDay: number; totals: { raised: number; os: number; paused: number }; medianMinutesToDone: number | null }

const HOUR = 60 * 60 * 1000;
/** 9 AM tomorrow, local time. */
function tomorrowMorning(now = new Date()): Date {
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
}
const time = (iso: string) => {
  const d = new Date(iso), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};
const mins = (m: number) => (m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

export function NotificationsPause({ prefs, onSet }: { prefs: NoticePrefs; onSet: (patch: Patch & { pauseUntil?: string | null }) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    void gateway.send("notifications:stats", { days: 7 }).then((r) => {
      const d = r.success ? (r.data as Stats | undefined) : undefined;
      setStats(d && typeof d.totals?.raised === "number" ? d : null);
    }).catch(() => {});
  }, [prefs]);
  const paused = pausedAt(prefs);
  const pause = (v: string) => {
    if (!v) return;
    const until = v === "tomorrow" ? tomorrowMorning() : new Date(Date.now() + Number(v) * HOUR);
    onSet({ pauseUntil: until.toISOString() });
  };
  return (
    <>
      <div className="notif-group notif-pause">
        <SettingRow label="Do Not Disturb"
          hint={paused ? `On until ${time(prefs.pauseUntil!)}. Dots still show; Urgent still comes through.` : "Pause desktop notifications for a while. Dots still show."}>
          {paused
            ? <button type="button" className="btn btn--secondary" onClick={() => onSet({ pauseUntil: null })}>Turn off</button>
            : (
              <select className="notif-settings__select" aria-label="Pause desktop notifications" value="" onChange={(e) => pause(e.target.value)}>
                <option value="">Pause…</option>
                <option value="1">For 1 hour</option>
                <option value="3">For 3 hours</option>
                <option value="tomorrow">Until tomorrow morning</option>
              </select>
            )}
        </SettingRow>
      </div>
      {stats && stats.totals.raised > 0 && (
        <p className="notif-settings__note notif-stats">
          Last 7 days: {stats.totals.raised} {stats.totals.raised === 1 ? "notice" : "notices"} (about {stats.perDay} a day),
          {" "}{stats.totals.os} desktop {stats.totals.os === 1 ? "notification" : "notifications"}
          {stats.totals.paused ? `, ${stats.totals.paused} held by Do Not Disturb` : ""}
          {stats.medianMinutesToDone !== null ? `. Usually handled within ${mins(stats.medianMinutesToDone)}.` : "."}
        </p>
      )}
    </>
  );
}
