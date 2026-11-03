/**
 * Top of Settings → Notifications (matches the redesign mock): your system's notification settings
 * for Papr Work, how Focus applies, and whether desktop notifications show the message text.
 */
import { PREVIEWS, previewsOf, type NoticePrefs, type Previews } from "../../../src/core/notifications/prefs";
import { SettingRow } from "./SettingRow";

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
const OS = MAC ? "macOS" : "your system";
const LABEL: Record<Previews, string> = { always: "Always", unlocked: "When unlocked", never: "Never" };

export function NotificationsTop({ prefs, onSet }: { prefs: NoticePrefs; onSet: (patch: { previews: Previews }) => void }) {
  const open = window.electronAPI?.notices?.openOsSettings;
  const pv = previewsOf(prefs);
  return (
    <div className="notif-group notif-top">
      <SettingRow label={`${MAC ? "macOS" : "System"} notifications for Papr Work`}
        hint={`Papr Work can't show anything on your desktop if it's turned off in ${OS}`}>
        {open ? <button type="button" className="btn btn--secondary" onClick={() => void open()}>Open System Settings</button> : <span />}
      </SettingRow>
      {MAC && (
        <SettingRow label="Follows macOS Focus" hint="When a Focus or Do Not Disturb is on, macOS holds Papr Work's desktop notifications. Dots still show.">
          <span className="notif-settings__fixed">Always</span>
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
