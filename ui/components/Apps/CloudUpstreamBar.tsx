/**
 * Upstream sync bar for cloud-installed forks — pull publisher updates + send changes.
 */

import { useEffect, useRef, useState } from "react";
import {
  formatLastSyncedAt,
  formatTrackSyncSummary,
  pullTrackUpstream,
  type TrackSyncResult,
} from "../../utils/cloudTrackSyncApi";
import { submitCloudAppChange } from "../../utils/cloudContributeApi";
import type { ForkLineageInfo } from "./CloudContributeBackPanel";

interface CloudUpstreamBarProps {
  appTitle: string;
  lineage: ForkLineageInfo;
  lastSyncedAt?: string;
  busy?: boolean;
  onLastSyncedAtChange?: (iso: string) => void;
  onTrackPullComplete?: (result: TrackSyncResult) => void;
}

export function CloudUpstreamBar({
  appTitle,
  lineage,
  lastSyncedAt: lastSyncedAtProp,
  busy = false,
  onLastSyncedAtChange,
  onTrackPullComplete,
}: CloudUpstreamBarProps) {
  const [pulling, setPulling] = useState(false);
  const [pullNotice, setPullNotice] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [title, setTitle] = useState(`Updates to ${appTitle}`);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(lastSyncedAtProp);
  const sendPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLastSyncedAt(lastSyncedAtProp);
  }, [lastSyncedAtProp]);

  useEffect(() => {
    if (!sendOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (
        sendPopoverRef.current &&
        !sendPopoverRef.current.contains(event.target as Node)
      ) {
        setSendOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [sendOpen]);

  const lastSyncedLabel = formatLastSyncedAt(lastSyncedAt);
  const isTrack = lineage.mode === "track";

  const handlePull = async () => {
    setPulling(true);
    setPullError(null);
    setPullNotice(null);
    try {
      const result = await pullTrackUpstream(lineage.installedAppId);
      setLastSyncedAt(result.lastSyncedAt);
      onLastSyncedAtChange?.(result.lastSyncedAt);
      setPullNotice(formatTrackSyncSummary(result));
      onTrackPullComplete?.(result);
    } catch (err) {
      setPullError((err as Error).message.slice(0, 120));
    } finally {
      setPulling(false);
    }
  };

  const handleSend = async () => {
    if (!description.trim()) {
      setSendError("Describe what you changed");
      return;
    }
    setSubmitting(true);
    setSendError(null);
    setSendMessage(null);
    try {
      await submitCloudAppChange({
        sourceNamespaceId: lineage.sourceNamespaceId,
        sourceSlug: lineage.sourceSlug,
        installedAppId: lineage.installedAppId,
        title: title.trim(),
        description: description.trim(),
      });
      setSendMessage("Change request sent to the owner.");
      setDescription("");
      setSendOpen(false);
    } catch (err) {
      setSendError((err as Error).message.slice(0, 120));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mini-app-publish-bar__upstream">
      <div className="mini-app-publish-bar__track-pull-copy">
        <span className="mini-app-publish-bar__track-pull-label">
          Upstream · {lineage.sourceSlug}
        </span>
        <span className="mini-app-publish-bar__track-pull-meta">
          {isTrack
            ? lastSyncedLabel
              ? `Last pulled ${lastSyncedLabel}`
              : "Not pulled yet"
            : "Fork — send edits to the owner"}
        </span>
      </div>

      <div className="mini-app-publish-bar__upstream-actions">
        {isTrack ? (
          <button
            type="button"
            className="mini-app-publish-bar__button mini-app-publish-bar__button--track"
            disabled={busy || pulling}
            title="Download the publisher's latest code into your local copy"
            onClick={() => void handlePull()}
          >
            {pulling ? "Pulling…" : "Pull latest"}
          </button>
        ) : null}

        <div className="mini-app-publish-bar__send-wrap" ref={sendPopoverRef}>
          <button
            type="button"
            className="mini-app-publish-bar__button mini-app-publish-bar__button--track mini-app-publish-bar__button--send"
            disabled={busy || submitting}
            title="Send your local changes to the app owner for review"
            onClick={() => {
              setSendOpen((open) => !open);
              setSendError(null);
              setSendMessage(null);
            }}
          >
            {submitting ? "Sending…" : "Send changes"}
          </button>

          {sendOpen ? (
            <div className="mini-app-publish-bar__send-popover" role="dialog">
              <p className="mini-app-publish-bar__send-popover-title">
                Send changes to owner
              </p>
              <p className="mini-app-publish-bar__send-popover-desc">
                The owner can review and merge your edits into the shared app.
              </p>
              <label className="share-sheet__field-label" htmlFor="upstream-change-title">
                Request title
              </label>
              <input
                id="upstream-change-title"
                className="share-sheet__text-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy || submitting}
              />
              <label className="share-sheet__field-label" htmlFor="upstream-change-desc">
                What changed?
              </label>
              <textarea
                id="upstream-change-desc"
                className="share-sheet__textarea"
                rows={3}
                placeholder="Describe fixes or features for the owner to review…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy || submitting}
              />
              {sendError ? (
                <p className="share-sheet__error">{sendError}</p>
              ) : null}
              <button
                type="button"
                className="share-sheet__primary-btn"
                disabled={busy || submitting}
                onClick={() => void handleSend()}
              >
                {submitting ? "Sending…" : "Submit change request"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {pullNotice ? (
        <span className="mini-app-publish-bar__upstream-toast">{pullNotice}</span>
      ) : null}
      {pullError ? (
        <span className="mini-app-publish-bar__upstream-error">{pullError}</span>
      ) : null}
      {sendMessage ? (
        <span className="mini-app-publish-bar__upstream-toast">{sendMessage}</span>
      ) : null}
    </div>
  );
}
