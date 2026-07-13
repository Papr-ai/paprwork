/**
 * AppWorkspaceMenu — preview icon with dropdown to switch Preview / Files view.
 */

import React, { useEffect, useRef, useState } from "react";
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

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12l4 4L19 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppWorkspaceMenu({ mode, onModeChange, align = "left" }: AppWorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const pick = (next: AppWorkspaceMode) => {
    onModeChange(next);
    setOpen(false);
  };

  const toggleTarget: AppWorkspaceMode = mode === "preview" ? "files" : "preview";

  return (
    <div
      className={
        align === "right"
          ? "app-workspace-menu app-workspace-menu--align-right"
          : "app-workspace-menu"
      }
      ref={rootRef}
    >
      <button
        type="button"
        className="app-workspace-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          toggleTarget === "files"
            ? "Switch to Files"
            : "Switch to Preview"
        }
        onClick={() => setOpen((value) => !value)}
      >
        {toggleTarget === "files" ? <FolderIcon /> : <PreviewIcon />}
        <span className="app-workspace-menu__label">
          {toggleTarget === "files" ? "Files" : "Preview"}
        </span>
      </button>

      {open ? (
        <div className="app-workspace-menu__dropdown" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "preview"}
            className={
              mode === "preview"
                ? "app-workspace-menu__item app-workspace-menu__item--active"
                : "app-workspace-menu__item"
            }
            onClick={() => pick("preview")}
          >
            <PreviewIcon />
            <span className="app-workspace-menu__item-text">
              <span className="app-workspace-menu__item-label">Preview</span>
              <span className="app-workspace-menu__item-desc">
                Run the live app
              </span>
            </span>
            {mode === "preview" ? (
              <span className="app-workspace-menu__check">
                <CheckIcon />
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "files"}
            className={
              mode === "files"
                ? "app-workspace-menu__item app-workspace-menu__item--active"
                : "app-workspace-menu__item"
            }
            onClick={() => pick("files")}
          >
            <FolderIcon />
            <span className="app-workspace-menu__item-text">
              <span className="app-workspace-menu__item-label">Files</span>
              <span className="app-workspace-menu__item-desc">
                Browse and edit source code
              </span>
            </span>
            {mode === "files" ? (
              <span className="app-workspace-menu__check">
                <CheckIcon />
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}
