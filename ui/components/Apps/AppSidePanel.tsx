/**
 * AppSidePanel — data, jobs, code and files beside the running app.
 *
 * Opens next to the app (like browser devtools) so the app stays on screen
 * while you look at what's behind it. Expand to full width for the full
 * layouts; "‹ App" in the header goes back to side by side.
 */

import type { ReactNode } from "react";
import { AppJobsPanel } from "./AppJobsPanel";
import { MiniAppFilesView } from "./MiniAppFilesView";
import "./AppSidePanel.css";

export type AppSideTab = "data" | "jobs" | "code" | "files";

const TABS: Array<[AppSideTab, string]> = [
  ["data", "Data"],
  ["jobs", "Jobs"],
  ["code", "Code"],
  ["files", "Files"],
];

interface AppSidePanelProps {
  appId: string;
  tab: AppSideTab;
  wide: boolean;
  jobCount?: number;
  focusJobId?: string | null;
  /** Table to open on the Data tab (Share sheet pill). */
  openTable?: { db: string; table: string } | null;
  onTableOpened?: () => void;
  onTabChange: (tab: AppSideTab) => void;
  onWideChange: (wide: boolean) => void;
  onClose: () => void;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="asp-icon-btn" aria-label={label} title={label} onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

export function AppSidePanel({
  appId,
  tab,
  wide,
  jobCount,
  focusJobId,
  openTable,
  onTableOpened,
  onTabChange,
  onWideChange,
  onClose,
}: AppSidePanelProps) {
  return (
    <aside className={`asp${wide ? " asp--wide" : ""}`} aria-label="Data and code">
      <div className="asp-head">
        {wide ? (
          <>
            <button
              type="button"
              className="asp-back"
              title="Back to side by side"
              onClick={() => onWideChange(false)}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 3.5 5.5 8l4.5 4.5" />
              </svg>
              App
            </button>
            <i className="asp-sep" aria-hidden />
          </>
        ) : null}
        <div className="asp-tabs" role="tablist" aria-label="Data and code">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`asp-tab${tab === id ? " is-on" : ""}`}
              onClick={() => onTabChange(id)}
            >
              {label}
              {id === "jobs" && jobCount ? <span className="asp-count">{jobCount}</span> : null}
            </button>
          ))}
        </div>
        <div className="asp-tools">
          {wide ? null : (
            <IconButton label="Full width" onClick={() => onWideChange(true)}>
              <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
            </IconButton>
          )}
          <IconButton label="Close" onClick={onClose}>
            <path d="M4 4l8 8M12 4l-8 8" />
          </IconButton>
        </div>
      </div>
      <div className="asp-body">
        {tab === "jobs" ? (
          <AppJobsPanel appId={appId} compact={!wide} focusJobId={focusJobId} />
        ) : (
          <MiniAppFilesView
            appId={appId}
            panel={tab === "data" ? "db" : tab}
            openTable={tab === "data" ? openTable : null}
            onTableOpened={onTableOpened}
          />
        )}
      </div>
    </aside>
  );
}
