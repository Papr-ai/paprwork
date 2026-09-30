/**
 * Provider failures, sized like a status light rather than an announcement.
 *
 * It sits beside the context dial for a reason: that corner of the composer is
 * already where this chat reports on itself, so a second object there is found
 * without being taught. It stays a separate object because the dial encodes a
 * continuous quantity — how full the window is — and folding a discrete,
 * transient failure into the same ring would make its amber mean two
 * unrelated things at once.
 *
 * Closed, the chip is the whole summary: tone plus a three-word headline.
 * Open, it is one sentence about what to do, at most one button that does it,
 * and the provider's untouched text one click further down for whoever wants
 * to paste it into a bug report.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ensureSettingsTab } from "../../lib/ensureSettingsTab";
import type { ProviderNotice } from "../../utils/providerErrorPresentation";
import "./ProviderErrorChip.css";

interface ProviderErrorChipProps {
  notice: ProviderNotice;
  isResuming?: boolean;
  onResume?: () => void;
  onDismiss?: () => void;
}

export const ProviderErrorChip: React.FC<ProviderErrorChipProps> = ({
  notice,
  isResuming = false,
  onResume,
  onDismiss,
}) => {
  const [open, setOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A new failure must not inherit the previous one's disclosure state: the
  // details of a rate limit have nothing to do with the auth error after it.
  useEffect(() => {
    setShowDetail(false);
  }, [notice.kind, notice.detail]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleAction = useCallback(() => {
    if (notice.action === "resume") {
      onResume?.();
      setOpen(false);
      return;
    }
    if (notice.action === "settings") {
      ensureSettingsTab({ section: "models" });
      setOpen(false);
    }
  }, [notice.action, onResume]);

  const actionLabel =
    notice.action === "resume"
      ? isResuming
        ? "Resuming…"
        : "Resume"
      : "Open settings";

  return (
    <div className="provider-notice" ref={containerRef}>
      <button
        type="button"
        className={`provider-notice__chip provider-notice__chip--${notice.tone}`}
        data-testid="provider-notice-chip"
        aria-expanded={open}
        aria-label={`${notice.headline}. ${notice.guidance}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="provider-notice__dot" aria-hidden="true" />
        <span className="provider-notice__headline">{notice.headline}</span>
      </button>

      {open && (
        <div
          className="provider-notice__panel"
          role="dialog"
          data-testid="provider-notice-panel"
        >
          <div className="provider-notice__panel-head">
            <span
              className={`provider-notice__dot provider-notice__dot--${notice.tone}`}
              aria-hidden="true"
            />
            <h3 className="provider-notice__title">{notice.headline}</h3>
            <button
              type="button"
              className="provider-notice__close"
              aria-label="Dismiss"
              onClick={() => {
                setOpen(false);
                onDismiss?.();
              }}
            >
              ✕
            </button>
          </div>

          <p className="provider-notice__guidance">{notice.guidance}</p>

          {notice.action !== "none" && (
            <button
              type="button"
              className="provider-notice__action"
              data-testid="provider-notice-action"
              disabled={notice.action === "resume" && isResuming}
              onClick={handleAction}
            >
              {actionLabel}
            </button>
          )}

          {notice.detail && (
            <>
              <button
                type="button"
                className="provider-notice__disclosure"
                aria-expanded={showDetail}
                onClick={() => setShowDetail((value) => !value)}
              >
                {showDetail ? "Hide details" : "Details"}
              </button>
              {showDetail && (
                <pre className="provider-notice__detail">{notice.detail}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
