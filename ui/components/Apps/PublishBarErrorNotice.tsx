/**
 * Clickable publish error in the share bar — opens a bottom-right detail panel.
 */

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./PublishBarErrorNotice.css";

interface PublishBarErrorNoticeProps {
  summary: string;
  detail: string;
  onDismiss?: () => void;
  /** v2: status chip opens the panel; omit the inline bar trigger. */
  hideInlineTrigger?: boolean;
  detailOpen?: boolean;
  onDetailOpenChange?: (open: boolean) => void;
  panelTitle?: string;
}

export function PublishBarErrorNotice({
  summary,
  detail,
  onDismiss,
  hideInlineTrigger = false,
  detailOpen: detailOpenProp,
  onDetailOpenChange,
  panelTitle = "Failed to publish",
}: PublishBarErrorNoticeProps) {
  const [detailOpenInternal, setDetailOpenInternal] = useState(false);
  const detailOpen = detailOpenProp ?? detailOpenInternal;
  const setDetailOpen = onDetailOpenChange ?? setDetailOpenInternal;
  const needsDetail = detail.trim() !== summary.trim();

  useEffect(() => {
    if (!detailOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailOpen(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [detailOpen]);

  const openDetail = () => {
    if (needsDetail) {
      setDetailOpen(true);
    }
  };

  return (
    <>
      {!hideInlineTrigger ? (
        <button
          type="button"
          className="publish-bar-error-notice"
          onClick={openDetail}
          title={detail}
          aria-label={needsDetail ? `${summary}. View full error.` : summary}
        >
          <span className="publish-bar-error-notice__text">{summary}</span>
          {needsDetail ? (
            <span className="publish-bar-error-notice__action">Details</span>
          ) : null}
        </button>
      ) : null}

      {detailOpen
        ? createPortal(
            <div
              className="publish-error-detail-panel__backdrop"
              role="presentation"
              onClick={() => setDetailOpen(false)}
            >
              <div
                className="publish-error-detail-panel"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="publish-error-detail-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="publish-error-detail-panel__header">
                  <h3
                    id="publish-error-detail-title"
                    className="publish-error-detail-panel__title"
                  >
                    {panelTitle}
                  </h3>
                  <button
                    type="button"
                    className="publish-error-detail-panel__close"
                    aria-label="Close"
                    onClick={() => setDetailOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <p className="publish-error-detail-panel__body">{detail}</p>
                <div className="publish-error-detail-panel__actions">
                  {onDismiss ? (
                    <button
                      type="button"
                      className="publish-error-detail-panel__btn"
                      onClick={() => {
                        onDismiss();
                        setDetailOpen(false);
                      }}
                    >
                      Dismiss
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="publish-error-detail-panel__btn publish-error-detail-panel__btn--primary"
                    onClick={() => setDetailOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
