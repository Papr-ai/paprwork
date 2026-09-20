/**
 * Owner panel — incoming contribute-back proposals for a published app.
 */

import { useState } from "react";
import {
  buildPrReviewAgentPrompt,
  openCloudSyncAgentChat,
} from "../../utils/openCloudSyncAgentChat";
import {
  contributorLabelForChangeRequest,
  resolveCloudChangeRequest,
  type CloudChangeRequest,
} from "../../utils/cloudChangeRequestsApi";
import { formatChangeRequestWhen } from "../../utils/formatChangeRequestWhen";

interface CloudChangeRequestsPanelProps {
  busy?: boolean;
  variant?: "share-sheet" | "publish-bar";
  requests: CloudChangeRequest[];
  pending: CloudChangeRequest[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
}

export function CloudChangeRequestsPanel({
  busy = false,
  variant = "share-sheet",
  requests,
  pending,
  loading,
  error,
  onReload,
}: CloudChangeRequestsPanelProps) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const displayError = localError ?? error;
  const rootClass =
    variant === "publish-bar"
      ? "publish-bar-contributions"
      : "share-sheet__section share-sheet__changes";

  const resolve = async (requestId: string, action: "approve" | "reject") => {
    setResolvingId(requestId);
    setLocalError(null);
    try {
      await resolveCloudChangeRequest(requestId, action);
      await onReload();
    } catch (err) {
      setLocalError((err as Error).message.slice(0, 200));
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className={rootClass}>
      {variant === "publish-bar" ? (
        <>
          <p className="publish-bar-contributions__title">Community proposals</p>
          <p className="publish-bar-contributions__desc">
            People who installed your app can send changes back for review. Accept
            merges their work into your app; decline closes the proposal without
            affecting their copy.
          </p>
        </>
      ) : (
        <>
          <p className="share-sheet__section-title">Suggested updates</p>
          <p className="share-sheet__section-desc">
            When someone installs your app and sends changes back, their proposal
            appears here. Review the update, then accept to merge it into your app
            or decline to close it.
          </p>
        </>
      )}

      {loading ? (
        <p className="share-sheet__footnote">Loading proposals…</p>
      ) : displayError ? (
        <p className="share-sheet__error">{displayError}</p>
      ) : pending.length === 0 ? (
        <p className="share-sheet__footnote">No pending proposals.</p>
      ) : (
        <ul className="share-sheet__changes-list">
          {pending.map((req) => {
            const contributor = contributorLabelForChangeRequest(req);
            const when = formatChangeRequestWhen(req.createdAt);
            return (
              <li key={req.id} className="share-sheet__changes-item">
                <div className="share-sheet__changes-head">
                  <strong>{req.title}</strong>
                  {when ? (
                    <span className="share-sheet__changes-meta">{when}</span>
                  ) : null}
                </div>
                {contributor ? (
                  <p className="share-sheet__changes-contributor">
                    From {contributor}
                  </p>
                ) : null}
                <p className="share-sheet__changes-desc">{req.description}</p>
                {req.prUrl ? (
                  <p className="share-sheet__changes-meta">
                    <a
                      className="share-sheet__link-btn"
                      href={req.prUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Review proposed changes
                    </a>
                    {typeof req.prNumber === "number" ? (
                      <span> · PR #{req.prNumber}</span>
                    ) : null}
                  </p>
                ) : (
                  <p className="share-sheet__footnote">
                    Waiting for change upload to finish…
                  </p>
                )}
                <div className="share-sheet__changes-actions">
                  <button
                    type="button"
                    className="share-sheet__secondary-btn"
                    disabled={busy || !req.prUrl}
                    onClick={() => {
                      openCloudSyncAgentChat(
                        buildPrReviewAgentPrompt({
                          sourceAppId: req.sourceAppId,
                          title: req.title,
                          description: req.description,
                          prUrl: req.prUrl,
                        }),
                      );
                    }}
                  >
                    Review with agent
                  </button>
                  <button
                    type="button"
                    className="share-sheet__primary-btn"
                    disabled={busy || resolvingId === req.id || !req.prUrl}
                    title={
                      req.prUrl
                        ? "Merge this proposal into your app"
                        : "Available once the proposal upload completes"
                    }
                    onClick={() => void resolve(req.id, "approve")}
                  >
                    {resolvingId === req.id ? "Working…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    className="share-sheet__secondary-btn"
                    disabled={busy || resolvingId === req.id}
                    onClick={() => void resolve(req.id, "reject")}
                  >
                    Decline
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {requests.some((r) => r.status !== "pending") ? (
        <p className="share-sheet__footnote">
          {requests.filter((r) => r.status === "approved").length} accepted ·{" "}
          {requests.filter((r) => r.status === "rejected").length} declined
        </p>
      ) : null}
    </div>
  );
}
