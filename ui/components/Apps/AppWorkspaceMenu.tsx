/**
 * AppWorkspaceMenu — single toggle between Preview and Files.
 */

import type { AppWorkspaceMode } from "../../hooks/useAppWorkspace";
import "./AppWorkspaceMenu.css";

interface AppWorkspaceMenuProps {
  mode: AppWorkspaceMode;
  onModeChange: (mode: AppWorkspaceMode) => void;
  align?: "left" | "right";
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="13"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M8 20h8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppWorkspaceMenu({
  mode,
  onModeChange,
  align = "left",
}: AppWorkspaceMenuProps) {
  const isPreview = mode === "preview";
  const nextMode = isPreview ? "files" : "preview";

  return (
    <div
      className={
        align === "right"
          ? "app-workspace-menu app-workspace-menu--align-right"
          : "app-workspace-menu"
      }
    >
      <button
        type="button"
        className="app-workspace-menu__toggle-btn"
        title={isPreview ? "Browse and edit source code" : "Run the live app"}
        aria-label={isPreview ? "Switch to Files" : "Switch to Preview"}
        onClick={() => onModeChange(nextMode)}
      >
        {isPreview ? <FolderIcon /> : <PreviewIcon />}
        <span>{isPreview ? "Files" : "Preview"}</span>
      </button>
    </div>
  );
}
