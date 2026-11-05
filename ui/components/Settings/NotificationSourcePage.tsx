/**
 * One source's page in Settings → Notifications (like one app in iOS Settings → Notifications):
 * allow, a small table of where each kind appears, chips to turn single types off, and how its
 * desktop notifications behave.
 */
import type { NoticeSourceDef, NoticeCategory } from "../../../src/core/notifications/sources";
import { SURFACES, sourcePref, typeOn, typeKey, type NoticePrefs, type Surface } from "../../../src/core/notifications/prefs";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";

export const SURFACE_LABEL: Record<Surface, [string, string]> = {
  desktop: ["Desktop", "A macOS or Windows notification. Only when Papr Work isn't in front."],
  badge: ["Badges", "A dot on the thing and on its icon in the sidebar."],
};
const ROW: Record<NoticeCategory, [string, string]> = { needs: ["Waiting on you", "blue"], done: ["Done and updates", "green"] };

export type Patch = { sources?: Record<string, object>; types?: Record<string, boolean> };

export function NotificationSourcePage({ src, prefs, onSet, onBack }: {
  src: NoticeSourceDef; prefs: NoticePrefs; onSet: (patch: Patch) => void; onBack: () => void;
}) {
  const p = sourcePref(prefs, src.id), off = !p.allow;
  const cats = (["needs", "done"] as const).filter((c) => src.types.some((t) => t.cat === c));
  const setSurf = (c: NoticeCategory, k: Surface) => onSet({ sources: { [src.id]: { [c]: { [k]: !p[c][k] } } } });
  const desk = cats.some((c) => p[c].desktop), loud = cats.includes("needs") && p.needs.desktop;
  return (
    <div className="settings-section notif-src">
      <button type="button" className="notif-src__back" onClick={onBack}>&larr; Notifications</button>
      <h2 className="settings-section__title">{src.name}</h2>
      <p className="settings-section__description">{src.desc}</p>
      <SettingRow label="Allow notifications" hint={off ? "Off: you'll only see these inside the thing they're about" : "They can reach you outside the thing they're about"}>
        <Toggle checked={p.allow} onChange={(v) => onSet({ sources: { [src.id]: { allow: v } } })} ariaLabel={`Allow notifications from ${src.name}`} />
      </SettingRow>
      <h3 className="notif-settings__h">Where it appears</h3>
      <table className={`notif-grid${off ? " is-dim" : ""}`}>
        <thead><tr><th />{SURFACES.map((k) => <th key={k} title={SURFACE_LABEL[k][1]}><span className={`notif-art notif-art--${k}`} />{SURFACE_LABEL[k][0]}</th>)}</tr></thead>
        <tbody>
          {cats.map((c) => (
            <tr key={c}>
              <th>
                <b><i className={`notif-dot notif-dot--${ROW[c][1]}`} />{ROW[c][0]}</b>
                <span className="notif-chips">
                  {src.types.filter((t) => t.cat === c).map((t) => {
                    const on = typeOn(prefs, src.id, t.id);
                    return (
                      <button key={t.id} type="button" className={`notif-chip${on ? " is-on" : ""}`} aria-pressed={on} disabled={off}
                        title={`${t.label}${on ? "" : " (off)"}`} aria-label={t.label}
                        onClick={() => onSet({ types: { [typeKey(src.id, t.id)]: !on } })}>{t.chip}</button>
                    );
                  })}
                </span>
              </th>
              {SURFACES.map((k) => (
                <td key={k}>
                  <button type="button" className={`notif-cb${p[c][k] ? " is-on" : ""}`} aria-pressed={p[c][k]} disabled={off}
                    aria-label={`${ROW[c][0]}: ${SURFACE_LABEL[k][0]}`} onClick={() => setSurf(c, k)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {src.id === "account" && (
        <div className="notif-group notif-always">
          <SettingRow label="Billing and sign-in problems" hint="Papr Work stops until they're fixed, so these always reach you">
            <span className="notif-settings__fixed">Always on</span>
          </SettingRow>
        </div>
      )}
      <h3 className="notif-settings__h">Desktop notifications</h3>
      <div className={`notif-group${off || !desk ? " is-dim" : ""}`}>
        <SettingRow label="Sound" disabled={off || !loud}
          hint={!loud ? "Done and updates are always quiet" : p.sound ? "Plays for things waiting on you. Done and updates stay quiet." : "Off: they show without a sound"}>
          <Toggle checked={p.sound} onChange={(v) => onSet({ sources: { [src.id]: { sound: v } } })} ariaLabel={`Sound for ${src.name}`} disabled={off || !loud} />
        </SettingRow>
      </div>
    </div>
  );
}
