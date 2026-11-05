/**
 * Top of Settings → Notifications (matches the redesign mock): whether macOS lets Papr Work notify you,
 * how Focus applies, and whether desktop notifications show the message text.
 */
import { useEffect, useState } from "react";
import { PREVIEWS, previewsOf, type NoticePrefs, type Previews } from "../../../src/core/notifications/prefs";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
const OS = MAC ? "macOS" : "your system";
const LABEL: Record<Previews, string> = { always: "Always", unlocked: "When unlocked", never: "Never" };
type Access = "on" | "off" | "unknown";
const ACCESS: Record<Access, [string, string]> = {
  on: [`${OS === "macOS" ? "macOS" : "System"} notifications are on for Papr Work`, "Desktop notifications can reach you"],
  off: [`${OS === "macOS" ? "macOS" : "System"} notifications are off for Papr Work`, "Nothing can reach your desktop. Turn them on in System Settings."],
  unknown: [`${OS === "macOS" ? "macOS" : "System"} notifications for Papr Work`, `Papr Work can't show anything on your desktop if it's turned off in ${OS}`],
};

export function NotificationsTop({ prefs, onSet }: { prefs: NoticePrefs; onSet: (patch: { previews: Previews }) => void }) {
  const api = window.electronAPI?.notices;
  const [access, setAccess] = useState<Access>("unknown");
  useEffect(() => {
    const check = () => void api?.osAccess?.().then((r) => setAccess(r.state)).catch(() => {});
    check();
    window.addEventListener("focus", check); // back from System Settings
    return () => window.removeEventListener("focus", check);
  }, [api]);
  const pv = previewsOf(prefs);
  return (
    <div className="notif-group notif-top">
      <SettingRow label={<span className="notif-access"><i className={`notif-access__dot is-${access}`} aria-hidden="true" />{ACCESS[access][0]}</span>}
        hint={ACCESS[access][1]}>
        {api?.openOsSettings ? <button type="button" className="btn btn--secondary" onClick={() => void api.openOsSettings?.()}>Open System Settings</button> : <span />}
      </SettingRow>
      {MAC && (
        <SettingRow label="Follow macOS Focus" hint="When a Focus or Do Not Disturb is on, desktop notifications wait. Dots still show.">
          <Toggle checked disabled onChange={() => {}} ariaLabel="Follow macOS Focus" />
        </SettingRow>
      )}
      <SettingRow label="Show previews" hint="Message text in desktop notifications">
        <div className="notif-seg" role="radiogroup" aria-label="Show previews">
          {PREVIEWS.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={pv === v} className={pv === v ? "is-on" : ""}
              onClick={() => pv !== v && onSet({ previews: v })}>{LABEL[v]}</button>
          ))}
        </div>
      </SettingRow>
    </div>
  );
}
