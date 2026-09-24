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
  /** Fork only — opens the contribute-back form in the Share sheet. */
  onPropose?: () => void;
  /** Upstream slug, so the menu item names who receives the proposal. */
  upstreamSlug?: string;
  /** Collaborator (track install): new app you own — same code, fresh data. */
  onDuplicateAsOwn?: () => void;
  /** Collaborator with local edits: reset to the publisher's code. */
  onDiscardEdits?: () => void;
  /** Reveal the app folder in Finder / Explorer. */
  onShowInFinder?: () => void;
  /** Copy into another org or workspace (same dialog as the Apps page card menu). */
  onCopyToWorkspace?: () => void;
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
  onPropose,
  upstreamSlug,
  onDuplicateAsOwn,
  onDiscardEdits,
  onShowInFinder,
  onCopyToWorkspace,
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

          {/* Forks had an empty menu — the only item was gated on !isFork.
              Propose lives here rather than in the bar because Update and
              Share my copy already compete for the primary slot, and sending
              changes upstream is the rarest of the three. */}
          {isFork && onPropose ? (
            <>
              <div className="pb-overflow__sep" />
              <button
                type="button"
                role="menuitem"
                className="pb-overflow__item"
                disabled={busy}
                onClick={() => {
                  onPropose();
                  setOpen(false);
                }}
              >
                Propose change
                <span className="pb-overflow__hint">
                  {upstreamSlug
                    ? `Send your edits to ${upstreamSlug}`
                    : "Send your edits to the app owner"}
                </span>
              </button>
            </>
          ) : null}

          {onDuplicateAsOwn || onDiscardEdits ? (
            <>
              <div className="pb-overflow__sep" />
              {onDuplicateAsOwn ? (
                <button
                  type="button"
                  role="menuitem"
                  className="pb-overflow__item"
                  disabled={busy}
                  onClick={() => {
                    onDuplicateAsOwn();
                    setOpen(false);
                  }}
                >
                  Duplicate as my own app
                  <span className="pb-overflow__hint">
                    Your own copy, to edit or share. Fresh data, no link to the publisher
                  </span>
                </button>
              ) : null}
              {onDiscardEdits ? (
                <button
                  type="button"
                  role="menuitem"
                  className="pb-overflow__item pb-overflow__item--danger"
                  disabled={busy}
                  onClick={() => {
                    onDiscardEdits();
                    setOpen(false);
                  }}
                >
                  Discard my edits
                  <span className="pb-overflow__hint">
                    {upstreamSlug
                      ? `Go back to ${upstreamSlug}'s latest code`
                      : "Go back to the publisher's latest code"}
                  </span>
                </button>
              ) : null}
            </>
          ) : null}

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

          {onCopyToWorkspace || onShowInFinder ? (
            <div className="pb-overflow__sep" />
          ) : null}
          {onCopyToWorkspace ? (
            <button
              type="button"
              role="menuitem"
              className="pb-overflow__item"
              disabled={busy}
              onClick={() => {
                onCopyToWorkspace();
                setOpen(false);
              }}
            >
              Copy to workspace…
              <span className="pb-overflow__hint">
                Independent copy in another org or workspace
              </span>
            </button>
          ) : null}
          {onShowInFinder ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="pb-overflow__item"
                onClick={() => {
                  onShowInFinder();
                  setOpen(false);
                }}
              >
                Show app files in Finder
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
