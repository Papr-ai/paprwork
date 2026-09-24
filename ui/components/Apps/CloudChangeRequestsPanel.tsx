/**
 * Owner panel — incoming contribute-back proposals for a published app.
 */

import { useState } from "react";
import {
  buildPrReviewAgentPrompt,
  openCloudSyncAgentChat,
} from "../../utils/openCloudSyncAgentChat";
import {
  changeRequestProposedByLine,
  resolveCloudChangeRequest,
  type CloudChangeRequest,
} from "../../utils/cloudChangeRequestsApi";
import {
  contributionAudienceKind,
  contributionPanelCopy,
} from "../../utils/contributionPanelCopy";
import {
  buildChangeRequestSummaryParts,
  changeRequestStagedPaths,
  changeRequestStatusLabel,
  isChangeRequestReadyForReview,
  listResolvedChangeRequests,
} from "../../utils/changeRequestDisplay";
import { formatChangeRequestWhen } from "../../utils/formatChangeRequestWhen";
import type { ShareAudience } from "../../utils/shareAudienceModel";

interface CloudChangeRequestsPanelProps {
  busy?: boolean;
  variant?: "share-sheet" | "modal";
  /** When set with variant modal, drives team vs community vs link copy. */
  shareAudience?: ShareAudience;
  appPublished?: boolean;
  /** Modal puts the title in the sheet header — skip duplicate heading. */
  showHeader?: boolean;
  requests: CloudChangeRequest[];
  pending: CloudChangeRequest[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
}

export function CloudChangeRequestsPanel({
  busy = false,
  variant = "share-sheet",
  shareAudience = "public",
  appPublished = true,
  showHeader = true,
  requests,
  pending,
  loading,
  error,
  onReload,
}: CloudChangeRequestsPanelProps) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pastOpen, setPastOpen] = useState(false);

  const resolved = listResolvedChangeRequests(requests);

  const displayError = localError ?? error;
  const audienceKind = contributionAudienceKind(shareAudience, appPublished);
  const copy = contributionPanelCopy(audienceKind);
  const rootClass =
    variant === "modal"
      ? "share-sheet__section share-sheet__changes share-sheet__changes--modal"
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
      {showHeader ? (
        <>
          <p className="share-sheet__section-title">{copy.title}</p>
          <p className="share-sheet__section-desc">{copy.description}</p>
        </>
      ) : null}

      {loading ? (
        <p className="share-sheet__footnote">{copy.loading}</p>
      ) : displayError ? (
        <p className="share-sheet__error">{displayError}</p>
      ) : pending.length === 0 ? (
        <p className="share-sheet__footnote">{copy.emptyPending}</p>
      ) : (
        <ul className="share-sheet__changes-list">
          {pending.map((req) => {
            const proposedBy = changeRequestProposedByLine(req, audienceKind);
            const when = formatChangeRequestWhen(req.createdAt);
            const preparing = req.status === "preparing";
            const ready = isChangeRequestReadyForReview(req);
            const summary = buildChangeRequestSummaryParts(req);
            return (
              <li key={req.id} className="share-sheet__changes-item">
                <div className="share-sheet__changes-head">
                  <strong>{req.title}</strong>
                  {when ? (
                    <span className="share-sheet__changes-meta">{when}</span>
                  ) : null}
                </div>
                {proposedBy ? (
                  <p className="share-sheet__changes-contributor">{proposedBy}</p>
                ) : null}
                {preparing ? (
                  <p className="share-sheet__footnote share-sheet__footnote--muted">
                    Upload still in progress — Accept and Review with agent unlock
                    when the proposal finishes uploading.
                  </p>
                ) : null}
                <div className="share-sheet__changes-summary">
                  <p className="share-sheet__changes-summary-label">Summary</p>
                  {summary.narrative ? (
                    <p className="share-sheet__changes-desc">{summary.narrative}</p>
                  ) : (
                    <p className="share-sheet__footnote">No description provided.</p>
                  )}
                  {summary.paths.length > 0 ? (
                    <ul className="share-sheet__changes-paths">
                      {summary.paths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  ) : null}
                  {summary.pathsOverflow > 0 ? (
                    <p className="share-sheet__footnote">
                      +{summary.pathsOverflow} more file
                      {summary.pathsOverflow === 1 ? "" : "s"}
                    </p>
                  ) : null}
                  {ready ? (
                    <p className="share-sheet__changes-meta share-sheet__changes-meta--plain">
                      {summary.commitRef ? (
                        <span>Commit {summary.commitRef}</span>
                      ) : null}
                      {summary.commitRef && summary.branch ? (
                        <span> · </span>
                      ) : null}
                      {summary.branch ? (
                        <span>Branch {summary.branch}</span>
                      ) : null}
                    </p>
                  ) : (
                    <p className="share-sheet__footnote">
                      Waiting for change upload to finish…
                    </p>
                  )}
                </div>
                <div className="share-sheet__changes-actions">
                  <button
                    type="button"
                    className="share-sheet__secondary-btn"
                    disabled={busy || !ready}
                    onClick={() => {
                      openCloudSyncAgentChat(
                        buildPrReviewAgentPrompt({
                          sourceAppId: req.sourceAppId,
                          title: req.title,
                          description: req.description,
                          requestId: req.id,
                          branch: req.branch,
                          headSha: req.headSha,
                          stagedPaths: changeRequestStagedPaths(req),
                        }),
                      );
                    }}
                  >
                    Review with agent
                  </button>
                  <button
                    type="button"
                    className="share-sheet__primary-btn"
                    disabled={busy || resolvingId === req.id || !ready}
                    title={
                      ready
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

      {!loading && !displayError && resolved.length > 0 ? (
        <div className="share-sheet__changes-history">
          <button
            type="button"
            className="share-sheet__text-link share-sheet__changes-history-toggle"
            onClick={() => setPastOpen((open) => !open)}
          >
            {pastOpen
              ? copy.hidePastProposals
              : copy.showPastProposals(resolved.length)}
          </button>
          {pastOpen ? (
            <>
              <p className="share-sheet__changes-summary-label share-sheet__changes-history-label">
                {copy.pastProposalsHeading}
              </p>
              <ul className="share-sheet__changes-list share-sheet__changes-list--history">
                {resolved.map((req) => {
                  const proposedBy = changeRequestProposedByLine(
                    req,
                    audienceKind,
                  );
                  const when =
                    formatChangeRequestWhen(req.resolvedAt ?? req.createdAt) ??
                    formatChangeRequestWhen(req.createdAt);
                  const summary = buildChangeRequestSummaryParts(req);
                  const statusLabel = changeRequestStatusLabel(req);
                  const statusClass =
                    req.status === "approved"
                      ? "share-sheet__changes-status--accepted"
                      : "share-sheet__changes-status--declined";
                  return (
                    <li
                      key={req.id}
                      className="share-sheet__changes-item share-sheet__changes-item--history"
                    >
                      <div className="share-sheet__changes-head">
                        <strong>{req.title}</strong>
                        <span
                          className={`share-sheet__changes-status ${statusClass}`}
                        >
                          {statusLabel}
                        </span>
                      </div>
                      {proposedBy ? (
                        <p className="share-sheet__changes-contributor">
                          {proposedBy}
                          {when ? ` · ${when}` : ""}
                        </p>
                      ) : when ? (
                        <p className="share-sheet__changes-meta">{when}</p>
                      ) : null}
                      {summary.narrative ? (
                        <p className="share-sheet__changes-desc share-sheet__changes-desc--history">
                          {summary.narrative}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
