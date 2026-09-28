/**
 * Owner panel — incoming contribute-back proposals for a published app.
 */

import { useEffect, useMemo, useState } from "react";
import {
  buildChangeRequestResolveAgentPrompt,
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
  listActionableIncomingChangeRequests,
  listResolvedChangeRequests,
  listUploadingIncomingChangeRequests,
  mergeOptimisticChangeRequestResolutions,
  type OptimisticChangeRequestResolution,
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
  pending: _pending,
  loading,
  error,
  onReload,
}: CloudChangeRequestsPanelProps) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [optimisticResolved, setOptimisticResolved] =
    useState<OptimisticChangeRequestResolution>(new Map());

  const effectiveRequests = useMemo(
    () => mergeOptimisticChangeRequestResolutions(requests, optimisticResolved),
    [requests, optimisticResolved],
  );
  const actionable = listActionableIncomingChangeRequests(effectiveRequests);
  const uploading = listUploadingIncomingChangeRequests(effectiveRequests);
  const resolved = listResolvedChangeRequests(effectiveRequests);

  const displayError = localError ?? error;

  useEffect(() => {
    if (!successNotice) {
      return;
    }
    const timer = setTimeout(() => setSuccessNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [successNotice]);
  const audienceKind = contributionAudienceKind(shareAudience, appPublished);
  const copy = contributionPanelCopy(audienceKind);
  const rootClass =
    variant === "modal"
      ? "share-sheet__section share-sheet__changes share-sheet__changes--modal"
      : "share-sheet__section share-sheet__changes";

  const resolve = async (req: CloudChangeRequest, action: "approve" | "reject") => {
    setResolvingId(req.id);
    setLocalError(null);
    setSuccessNotice(null);
    try {
      await resolveCloudChangeRequest(req.id, action);
      setOptimisticResolved((prev) => {
        const next = new Map(prev);
        next.set(req.id, action === "approve" ? "approved" : "rejected");
        return next;
      });
      setPastOpen(true);
      setSuccessNotice(
        action === "approve"
          ? "Accepted — the proposal moved to past proposals below."
          : "Declined — the proposal moved to past proposals below.",
      );
      await onReload();
      setOptimisticResolved((prev) => {
        if (!prev.has(req.id)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(req.id);
        return next;
      });
    } catch (err) {
      const message = (err as Error).message.slice(0, 200);
      openCloudSyncAgentChat(
        buildChangeRequestResolveAgentPrompt({
          action,
          requestId: req.id,
          title: req.title,
          sourceAppId: req.sourceAppId,
          description: req.description,
          error: message,
        }),
      );
      setLocalError("Couldn’t complete that action — opened a chat to help.");
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
      ) : (
        <>
          {displayError ? (
            <p className="share-sheet__error">{displayError}</p>
          ) : null}
          {successNotice ? (
            <p className="share-sheet__footnote share-sheet__changes-success">
              {successNotice}
            </p>
          ) : null}
          {!displayError && actionable.length === 0 && uploading.length === 0 ? (
            <p className="share-sheet__footnote">{copy.emptyPending}</p>
          ) : null}
          {actionable.length > 0 ? (
            <ul className="share-sheet__changes-list">
              {actionable.map((req) => {
                const proposedBy = changeRequestProposedByLine(req, audienceKind);
                const when = formatChangeRequestWhen(req.createdAt);
                const summary = buildChangeRequestSummaryParts(req);
                const working = resolvingId === req.id;
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
                    </div>
                    <div className="share-sheet__changes-actions">
                      <button
                        type="button"
                        className="share-sheet__secondary-btn"
                        disabled={busy || working}
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
                        disabled={busy || working}
                        title="Merge this proposal into your app"
                        onClick={() => void resolve(req, "approve")}
                      >
                        {working ? "Accepting…" : "Accept"}
                      </button>
                      <button
                        type="button"
                        className="share-sheet__secondary-btn"
                        disabled={busy || working}
                        onClick={() => void resolve(req, "reject")}
                      >
                        {working ? "Declining…" : "Decline"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {uploading.length > 0 ? (
            <div className="share-sheet__changes-uploading">
              <p className="share-sheet__changes-summary-label">
                Still uploading ({uploading.length})
              </p>
              <p className="share-sheet__footnote share-sheet__footnote--muted">
                These are not ready to accept yet. They will move up when the upload
                finishes, or you can cancel a stuck upload.
              </p>
              <ul className="share-sheet__changes-list share-sheet__changes-list--uploading">
                {uploading.map((req) => {
                  const proposedBy = changeRequestProposedByLine(req, audienceKind);
                  const when = formatChangeRequestWhen(req.createdAt);
                  const summary = buildChangeRequestSummaryParts(req);
                  const working = resolvingId === req.id;
                  return (
                    <li
                      key={req.id}
                      className="share-sheet__changes-item share-sheet__changes-item--uploading"
                    >
                      <div className="share-sheet__changes-head">
                        <strong>{req.title}</strong>
                        {when ? (
                          <span className="share-sheet__changes-meta">{when}</span>
                        ) : null}
                      </div>
                      {proposedBy ? (
                        <p className="share-sheet__changes-contributor">{proposedBy}</p>
                      ) : null}
                      {summary.narrative ? (
                        <p className="share-sheet__changes-desc share-sheet__changes-desc--history">
                          {summary.narrative}
                        </p>
                      ) : null}
                      <p className="share-sheet__footnote share-sheet__footnote--muted">
                        <span className="share-sheet__changes-upload-spinner" aria-hidden="true" />
                        Waiting for upload to finish…
                      </p>
                      <div className="share-sheet__changes-actions share-sheet__changes-actions--compact">
                        <button
                          type="button"
                          className="share-sheet__secondary-btn"
                          disabled={busy || working}
                          title="Cancel this incomplete proposal"
                          onClick={() => void resolve(req, "reject")}
                        >
                          {working ? "Canceling…" : "Cancel upload"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
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
