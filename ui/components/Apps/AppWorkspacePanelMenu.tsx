/**
 * Workspace section tabs — Code, DB, Files, Jobs — shown in the publish bar
 * while browsing app source (Files workspace mode).
 */

import type { AppWorkspacePanel } from "../../hooks/useAppWorkspace";
import "./AppWorkspacePanelMenu.css";

const PANELS: Array<{ id: AppWorkspacePanel; label: string }> = [
  { id: "code", label: "Code" },
  { id: "db", label: "DB" },
  { id: "files", label: "Files" },
  { id: "jobs", label: "Jobs" },
];

interface AppWorkspacePanelMenuProps {
  panel: AppWorkspacePanel;
  onPanelChange: (panel: AppWorkspacePanel) => void;
  jobCount?: number;
}

export function AppWorkspacePanelMenu({
  panel,
  onPanelChange,
  jobCount,
}: AppWorkspacePanelMenuProps) {
  return (
    <div
      className="app-workspace-panel-menu mini-app-publish-bar__segment"
      role="tablist"
      aria-label="Workspace sections"
    >
      {PANELS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={panel === id}
          className={
            panel === id
              ? "mini-app-publish-bar__segment-btn mini-app-publish-bar__segment-btn--active"
              : "mini-app-publish-bar__segment-btn"
          }
          onClick={() => onPanelChange(id)}
        >
          {label}
          {id === "jobs" && jobCount != null && jobCount > 0 ? (
            <span className="app-workspace-panel-menu__count">{jobCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
