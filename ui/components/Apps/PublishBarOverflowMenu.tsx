/**
 * PublishBarOverflowMenu — the "..." in the publish bar.
 *
 * Holds two kinds of thing the inline row should not carry: rare destructive
 * actions (Unpublish), and the Files/Preview mode switch, which is frequent but
 * not urgent and was costing a full-width button in a row that already runs out
 * of space at normal window widths.
 *
 * Sits before Share so the row reads secondary -> primary left to right, and so
 * the destructive item is never adjacent to the primary action.
 */

import { useEffect, useRef, useState } from "react";
import type { AppWorkspaceMode } from "../../hooks/useAppWorkspace";
import "./PublishBarOverflowMenu.css";

interface PublishBarOverflowMenuProps {
  mode: AppWorkspaceMode;
  onModeChange: (mode: AppWorkspaceMode) => void;
  live: boolean;
  isFork: boolean;
  busy?: boolean;
  onUnpublish: () => void;
}

/**
 * Three filled circles in a 1:1 viewBox, not a zero-length stroked path.
 *
 * Byte-identical geometry to the prototype's ICON.more (shared.ts): same
 * viewBox, same render size, same radii. Equivalent-looking numbers in a
 * different viewBox are not equivalent — scale silently changes the gap, which
 * is how this icon ended up reading as a dash twice.
 *
 * Spacing matters more than size: the gap must read clearly wider than the dots
 * (~1.5x diameter, cx spacing = 5r) or three circles merge into one mark.
 */
function MoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden focusable="false">
      <circle cx="1.75" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="14.25" cy="8" r="1.25" />
    </svg>
  );
}

export function PublishBarOverflowMenu({
  mode,
  onModeChange,
  live,
  isFork,
  busy = false,
  onUnpublish,
}: PublishBarOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape — a menu that traps the user is worse
  // than no menu, especially one holding a destructive action.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isPreview = mode === "preview";

  return (
    <div className="pb-overflow" ref={wrapRef}>
      <button
        type="button"
        className="mini-app-publish-bar__button pb-overflow__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>

      {open ? (
        <div className="pb-overflow__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="pb-overflow__item"
            onClick={() => {
              onModeChange(isPreview ? "files" : "preview");
              setOpen(false);
            }}
          >
            {isPreview ? "Browse app files" : "Back to preview"}
            <span className="pb-overflow__hint">
              {isPreview ? "Code, DB, jobs" : "Run the live app"}
            </span>
          </button>

          {live && !isFork ? (
            <>
              <div className="pb-overflow__sep" />
              <button
                type="button"
                role="menuitem"
                className="pb-overflow__item pb-overflow__item--danger"
                disabled={busy}
                onClick={() => {
                  onUnpublish();
                  setOpen(false);
                }}
              >
                Unpublish
                <span className="pb-overflow__hint">
                  Removes the live URL and Community listing
                </span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
