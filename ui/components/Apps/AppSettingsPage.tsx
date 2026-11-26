/**
 * Share bar v2 (plan step 7b, behind papr.shareBarV2): one Settings page for the app.
 *
 * Grouped list on the left, the chosen section on the right, full size (the app
 * is hidden while it's open; clicking Settings in the pill again closes it).
 *   Build:       Code, Database, Jobs (the existing panels)
 *   This app:    General, Versions, People & access, Web link, Where Live runs
 *   Connections: Files, Keys
 *   Advanced:    Copy & tools (everything from today's ⋯ menu)
 *
 * Actions that need the publish bar's sheets (App info, Who has access, Share,
 * Unpublish, Duplicate…) are sent as APP_SETTINGS_ACTION_EVENT; the bar runs them.
 */
import type { ReactNode } from "react";
import { SectionBody } from "./AppSettingsSections";
import "./AppSettingsPage.css";

export type SettingsSection =
  | "code" | "data" | "jobs"
  | "general" | "versions" | "access" | "web" | "runs"
  | "files" | "keys" | "advanced";

export type SettingsAction =
  | "app-info" | "access" | "share" | "copy-link" | "open-link" | "unpublish" | "contributions"
  | "reload" | "duplicate" | "copy-to-workspace" | "show-in-finder" | "discard-edits" | "detach";

export const APP_SETTINGS_ACTION_EVENT = "papr:app-settings-action";

export function sendSettingsAction(appId: string, action: SettingsAction): void {
  window.dispatchEvent(new CustomEvent(APP_SETTINGS_ACTION_EVENT, { detail: { appId, action } }));
}

export interface AppSettingsContext {
  /** Track collaborator (teammate's copy): no owner-only sections. */
  collaborator: boolean;
  live: boolean;
  /** Copy is on the team's data: Detach is refused there. */
  onTeamData: boolean;
  loggedIn: boolean;
  liveRunsOn: "local" | "published";
  onLiveRunsOnChange: (mode: "local" | "published") => void;
  /** Dot per Build item, e.g. { jobs: "bad" } when a job failed. */
  dots?: Partial<Record<"code" | "data" | "jobs", "info" | "warn" | "bad">>;
}

type Item = { id: SettingsSection; label: string; icon: ReactNode; group: string };

const I = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);

const ITEMS: Item[] = [
  { id: "code", label: "Code", group: "Build", icon: I(<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />) },
  { id: "data", label: "Database", group: "Build", icon: I(<><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>) },
  { id: "jobs", label: "Jobs", group: "Build", icon: I(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />) },
  { id: "general", label: "General", group: "This app", icon: I(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>) },
  { id: "versions", label: "Versions", group: "This app", icon: I(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>) },
  { id: "access", label: "People & access", group: "This app", icon: I(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 4a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" /></>) },
  { id: "web", label: "Web link", group: "This app", icon: I(<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />) },
  { id: "runs", label: "Where Live runs", group: "This app", icon: I(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>) },
  { id: "files", label: "Files", group: "Connections", icon: I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>) },
  { id: "keys", label: "Keys", group: "Connections", icon: I(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3" /></>) },
  { id: "advanced", label: "Copy & tools", group: "Advanced", icon: I(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>) },
];

/** Sections a teammate's copy doesn't have: they belong to the owner. */
const OWNER_ONLY = new Set<SettingsSection>(["general", "versions", "access", "web"]);

export function settingsItems(ctx: Pick<AppSettingsContext, "collaborator">): Item[] {
  return ITEMS.filter((i) => !(ctx.collaborator && OWNER_ONLY.has(i.id)));
}

interface Props {
  appId: string;
  section: SettingsSection;
  onSectionChange: (s: SettingsSection) => void;
  ctx: AppSettingsContext;
  focusJobId?: string | null;
  openTable?: { db: string; table: string } | null;
  onTableOpened?: () => void;
}

export function AppSettingsPage({ appId, section, onSectionChange, ctx, focusJobId, openTable, onTableOpened }: Props) {
  const items = settingsItems(ctx);
  const active = items.some((i) => i.id === section) ? section : items[0].id;
  let lastGroup = "";
  return (
    <div className="aset" role="region" aria-label="App settings">
      <nav className="aset__nav" aria-label="Settings sections">
        {items.map((i) => {
          const head = i.group !== lastGroup ? <div className="aset__grp">{i.group}</div> : null;
          lastGroup = i.group;
          const dot = (ctx.dots as Record<string, string | undefined> | undefined)?.[i.id];
          return (
            <div key={i.id} className="aset__navrow">
              {head}
              <button type="button" className={`aset__item${i.id === active ? " is-on" : ""}`}
                aria-current={i.id === active ? "page" : undefined} onClick={() => onSectionChange(i.id)}>
                {i.icon}<span>{i.label}</span>
                {dot ? <span className={`aset__dot aset__dot--${dot}`} aria-label="needs a look" /> : null}
              </button>
            </div>
          );
        })}
      </nav>
      <section className={`aset__body${["code", "data", "jobs", "files"].includes(active) ? " aset__body--tool" : ""}`}>
        <SectionBody appId={appId} section={active} ctx={ctx} focusJobId={focusJobId}
          openTable={openTable} onTableOpened={onTableOpened} />
      </section>
    </div>
  );
}
