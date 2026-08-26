/**
 * Web sync popover and status dot for the mini-app publish bar.
 */

import React from "react";
import type {
  AppCloudItemPhase,
  AppCloudSyncStatus,
  WebSyncVisualState,
} from "../../utils/appCloudSyncStatus";
import { formatLastUploadedAt } from "../../utils/appCloudSyncStatus";
import {
  buildMergeReviewAgentPrompt,
  buildSchemaDriftAgentPrompt,
  buildWriterConflictAgentPrompt,
  openCloudSyncAgentChat,
} from "../../utils/openCloudSyncAgentChat";
import { AUTO_UPLOAD_TOGGLE_LABEL } from "../../utils/appUploadMode";

export interface WebSyncPopoverProps {
  status: AppCloudSyncStatus | null;
  appId?: string;
  loading?: boolean;
  refreshing?: boolean;
  error: string | null;
  pushing: boolean;
  pulling: boolean;
  applyingUpdates: boolean;
  syncActionNeeded: boolean;
  onPushNow: () => void;
  onBumpQueue?: () => void;
  onPullUpdates: () => void;
  onApplyRemoteUpdates: () => void;
  /** Per-app: upload to web automatically vs Upload now only */
  autoUploadEnabled?: boolean;
  autoUploadUsesGlobalDefault?: boolean;
  autoUploadSaving?: boolean;
  onAutoUploadChange?: (enabled: boolean) => void;
  popoverRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  style?: React.CSSProperties;
}

function rowIcon(phase: AppCloudItemPhase, status?: string): string {
  if (status === "failed") return "✕";
  if (status === "updates_available") return "↓";
  switch (phase) {
    case "synced":
      return "✓";
    case "uploading":
      return "◷";
    case "not_uploaded":
    case "changed":
      return "⚠";
    default:
      return "·";
  }
}

function summarizeRemoteCommits(summary: string): string | null {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const allJobStatus = lines.every((line) =>
    /^[0-9a-f]{7,40}\s+cloud:\s+update job .+ status$/i.test(line),
  );
  if (allJobStatus) {
    return lines.length === 1
      ? "1 cloud job status update"
      : `${lines.length} cloud job status updates`;
  }
  if (lines.length === 1) {
    const line = lines[0];
    return line.length > 52 ? `${line.slice(0, 52)}…` : line;
  }
  return `${lines.length} remote commits`;
}

function shortDetail(text: string, max = 72): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function isActivePhase(phase: AppCloudItemPhase): boolean {
  return phase !== "synced";
}

export function WebSyncPopover({
  status,
  appId,
  loading = false,
  refreshing = false,
  error,
  pushing,
  pulling,
  applyingUpdates,
  syncActionNeeded,
  onPushNow,
  onBumpQueue,
  onPullUpdates,
  onApplyRemoteUpdates,
  autoUploadEnabled,
  autoUploadUsesGlobalDefault = false,
  autoUploadSaving = false,
  onAutoUploadChange,
  popoverRef,
  className,
  style,
}: WebSyncPopoverProps) {
  const busy = pushing || pulling || applyingUpdates || loading || refreshing || autoUploadSaving;
  const remoteReviewNeeded = status?.gitRemoteRequiresReview === true;
  const writerConflict = status?.writerConflict === true;
  const metadataSync = status?.gitRemoteMetadataSync === true;
  const activelyUploading = status?.overall === "uploading";
  const queuedForUpload = status?.uploadQueued === true;
  const showMergeReview = remoteReviewNeeded && !metadataSync;
  const showWriterConflict = writerConflict && !showMergeReview && !metadataSync;
  // status is null until the first sync check resolves, and this runs above
  // the `!status` guard below — keep it optional-chained.
  const schemaDriftBlocked =
    status?.hasSchemaDrift === true ||
    (status?.publishDetail?.toLowerCase().includes("schema") ?? false);
  const showSchemaDriftHelp =
    schemaDriftBlocked && !showMergeReview && !showWriterConflict && !metadataSync;
  const showAutoUploadToggle =
    onAutoUploadChange != null &&
    status?.overall !== "disabled" &&
    !showMergeReview &&
    !showWriterConflict &&
    !metadataSync;
  const popoverClassName = className
    ? `mini-app-publish-bar__sync-popover mini-app-publish-bar__sync-popover--stacked ${className}`
    : "mini-app-publish-bar__sync-popover mini-app-publish-bar__sync-popover--stacked";

  // No status yet (first open, or a check that has not resolved): show the
  // shell with Upload now rather than rendering nothing on click.
  if (!status) {
    return (
      <div
        ref={popoverRef}
        className={popoverClassName}
        style={style}
        role="dialog"
        aria-label="Web sync"
      >
        <p className="mini-app-publish-bar__sync-popover-title">Web sync</p>
        <p className="mini-app-publish-bar__sync-popover-summary">Checking…</p>
        {error ? <p className="mini-app-publish-bar__sync-popover-error">{error}</p> : null}
        <div className="mini-app-publish-bar__sync-popover-actions">
          <button
            type="button"
            className="mini-app-publish-bar__sync-popover-btn"
            disabled={busy}
            onClick={() => void onPushNow()}
          >
            {pushing ? "Uploading…" : "Upload now"}
          </button>
        </div>
      </div>
    );
  }

  const commitSummary =
    showMergeReview && status.gitRemoteReviewHeadline
      ? status.gitRemoteReviewHeadline
      : status.gitUpdatesSummary
        ? summarizeRemoteCommits(status.gitUpdatesSummary)
        : null;
  const showHeadline =
    !showMergeReview &&
    !metadataSync &&
    status.summaryLine.trim().length > 0;
  const headlineText =
    refreshing && !activelyUploading && !queuedForUpload && !status.summaryLine.trim()
      ? "Checking for updates…"
      : status.summaryLine;

  const statusRows: Array<{ key: string; icon: string; label: string; detail: string }> =
    [];

  if (isActivePhase(status.codePhase) || status.codeStatus === "failed") {
    statusRows.push({
      key: "code",
      icon: rowIcon(status.codePhase, status.codeStatus),
      label: "App code",
      detail: shortDetail(status.codeLabel),
    });
  }

  for (const job of status.dependentJobs) {
    if (isActivePhase(job.phase) || job.status === "failed") {
      statusRows.push({
        key: job.jobId,
        icon: rowIcon(job.phase, job.status),
        label: job.label,
        detail: shortDetail(job.detail),
      });
    }
  }

  for (const db of status.databases) {
    if (isActivePhase(db.phase)) {
      statusRows.push({
        key: `${db.alias}:${db.jobId ?? "registry"}`,
        icon: rowIcon(db.phase),
        label: db.alias,
        detail: shortDetail(db.detail),
      });
    }
  }

  if (status.hasRegistryDatabases && isActivePhase(status.registryPhase)) {
    statusRows.push({
      key: "registry",
      icon: rowIcon(status.registryPhase),
      label: "Registry",
      detail: shortDetail(status.registryLabel),
    });
  }

  if (status.publishStatus !== "synced") {
    statusRows.push({
      key: "publish",
      icon:
        status.publishStatus === "republishing"
          ? "◷"
          : status.publishStatus === "error"
            ? "✕"
            : "⚠",
      label: "Web link",
      detail: shortDetail(status.publishLabel ?? "Not ready"),
    });
  }

  if (
    status.uploadStatus &&
    status.uploadStatus !== "idle" &&
    status.uploadLabel
  ) {
    const uploadText = status.uploadDetail
      ? `${status.uploadLabel} — ${status.uploadDetail}`
      : status.uploadLabel;
    statusRows.push({
      key: "upload",
      icon:
        status.uploadStatus === "uploading"
          ? "◷"
          : status.uploadStatus === "failed"
            ? "✕"
            : status.uploadQueued
              ? "○"
              : "○",
      label: status.uploadQueued ? "Queue" : "Progress",
      detail: shortDetail(uploadText, 88),
    });
  }

  const allSynced =
    statusRows.length === 0 &&
    status.overall === "synced" &&
    !showMergeReview &&
    !showWriterConflict &&
    !metadataSync;

  return (
    <div
      ref={popoverRef}
      className={popoverClassName}
      style={style}
      role="dialog"
      aria-label="Web sync"
    >
      <p className="mini-app-publish-bar__sync-popover-title">Web sync</p>

      {showMergeReview ? (
        <div
          className="mini-app-publish-bar__sync-remote-banner mini-app-publish-bar__sync-remote-banner--review"
          role="status"
        >
          <p className="mini-app-publish-bar__sync-remote-banner-title">
            Merge cloud changes before upload
          </p>
          {commitSummary ? (
            <p className="mini-app-publish-bar__sync-remote-banner-body">{commitSummary}</p>
          ) : null}
        </div>
      ) : showWriterConflict ? (
        <div
          className="mini-app-publish-bar__sync-remote-banner mini-app-publish-bar__sync-remote-banner--review"
          role="status"
        >
          <p className="mini-app-publish-bar__sync-remote-banner-title">
            Upload conflict — cloud repo changed
          </p>
          <p className="mini-app-publish-bar__sync-remote-banner-body">
            Get updates or ask the agent to reconcile remote changes, then upload again.
          </p>
        </div>
      ) : metadataSync ? (
        <div
          className="mini-app-publish-bar__sync-remote-banner mini-app-publish-bar__sync-remote-banner--metadata"
          role="status"
        >
          <p className="mini-app-publish-bar__sync-remote-banner-title">
            Syncing cloud job status…
          </p>
          {commitSummary ? (
            <p className="mini-app-publish-bar__sync-remote-banner-body">{commitSummary}</p>
          ) : null}
        </div>
      ) : showHeadline ? (
        <p className="mini-app-publish-bar__sync-popover-summary">{headlineText}</p>
      ) : null}

      <div className="mini-app-publish-bar__sync-popover-scroll">
        {status.codeLastError ? (
          <p className="mini-app-publish-bar__sync-popover-error">{status.codeLastError}</p>
        ) : null}
        {status.overall === "disabled" ? (
          <p className="mini-app-publish-bar__sync-popover-hint">
            Turn on cloud sync in Settings.
          </p>
        ) : null}
        {!autoUploadEnabled && status.overall !== "synced" && status.overall !== "disabled" ? (
          <p className="mini-app-publish-bar__sync-popover-hint">
            Upload is manual for this app — click <strong>Upload now</strong> when you want
            local changes on the web. After sharing changes, wait until this panel shows
            synced before copying the external link.
          </p>
        ) : null}
        {showAutoUploadToggle ? (
          <label className="mini-app-publish-bar__sync-upload-toggle mini-app-publish-bar__sync-upload-toggle--compact">
            <input
              type="checkbox"
              checked={autoUploadEnabled ?? true}
              disabled={busy}
              onChange={(event) => {
                onAutoUploadChange?.(event.target.checked);
              }}
            />
            <span>{AUTO_UPLOAD_TOGGLE_LABEL}</span>
            {autoUploadUsesGlobalDefault ? (
              <span className="mini-app-publish-bar__sync-upload-toggle-note">
                (workspace default)
              </span>
            ) : null}
          </label>
        ) : null}
        {statusRows.length > 0 ? (
          <ul className="mini-app-publish-bar__sync-popover-list">
            {statusRows.map((row) => (
              <li key={row.key}>
                <span className="mini-app-publish-bar__sync-popover-icon">{row.icon}</span>
                <span>
                  <strong>{row.label}</strong> — {row.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : allSynced ? (
          <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--ok">
            {status.lastUploadedAt
              ? `Last uploaded ${formatLastUploadedAt(status.lastUploadedAt) ?? "recently"}.`
              : "Everything matches the web."}
          </p>
        ) : null}
        {error ? <p className="mini-app-publish-bar__sync-popover-error">{error}</p> : null}
      </div>

      <div className="mini-app-publish-bar__sync-popover-actions">
        {showWriterConflict ? (
          <>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildWriterConflictAgentPrompt({
                    appId,
                    error: status.codeLastError ?? error,
                  }),
                );
              }}
            >
              Ask agent
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || pushing}
              onClick={() => void onPullUpdates()}
            >
              {pulling ? "Getting updates…" : "Get updates"}
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync}
              onClick={() => void onPushNow()}
            >
              {activelyUploading || pushing ? "Uploading…" : "Upload now"}
            </button>
          </>
        ) : showSchemaDriftHelp ? (
          <>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildSchemaDriftAgentPrompt({
                    appId,
                    databases: status.databases.filter((db) => db.schemaDrift),
                    publishDetail: status.publishDetail,
                    error,
                  }),
                );
              }}
            >
              Ask agent
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync}
              onClick={() => void onPushNow()}
            >
              {activelyUploading || pushing ? "Uploading…" : "Upload now"}
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync || pushing}
              onClick={() => void onPullUpdates()}
            >
              {pulling ? "Getting updates…" : "Get updates"}
            </button>
            {error ? (
              <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
                Upload did not clear schema drift — try Ask agent to diagnose.
              </p>
            ) : null}
          </>
        ) : showMergeReview ? (
          <>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => void onApplyRemoteUpdates()}
            >
              {applyingUpdates ? "Merging…" : "Merge remote changes"}
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildMergeReviewAgentPrompt({
                    appId,
                    headline: status.gitRemoteReviewHeadline,
                    error,
                  }),
                );
              }}
            >
              Review with agent
            </button>
            {error ? (
              <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
                Merge failed — try again or use Review with agent.
              </p>
            ) : null}
            {(syncActionNeeded || pushing) && (
              <button
                type="button"
                className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
                disabled
                title="Merge remote changes first"
              >
                Upload now
              </button>
            )}
          </>
        ) : (
          <>
            {(syncActionNeeded || pushing || queuedForUpload) && (
              <>
                {queuedForUpload && onBumpQueue ? (
                  <button
                    type="button"
                    className="mini-app-publish-bar__sync-popover-btn"
                    disabled={busy || metadataSync}
                    onClick={() => void onBumpQueue()}
                  >
                    Move to front
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`mini-app-publish-bar__sync-popover-btn${
                    queuedForUpload && onBumpQueue
                      ? " mini-app-publish-bar__sync-popover-btn--secondary"
                      : ""
                  }`}
                  disabled={busy || metadataSync}
                  onClick={() => void onPushNow()}
                >
                  {activelyUploading || pushing
                    ? "Uploading…"
                    : queuedForUpload
                      ? "Upload now"
                      : "Upload now"}
                </button>
              </>
            )}
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync || pushing}
              onClick={() => void onPullUpdates()}
            >
              {pulling ? "Getting updates…" : "Get updates"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function WebSyncSpinner() {
  return <span className="mini-app-publish-bar__sync-chip-spinner" aria-hidden />;
}

interface WebSyncStatusDotProps {
  state: WebSyncVisualState;
  spinning?: boolean;
  tooltip: string;
  popoverOpen?: boolean;
  interactive?: boolean;
  onClick?: () => void;
}

export function WebSyncStatusDot({
  state,
  spinning = false,
  tooltip,
  popoverOpen = false,
  interactive = true,
  onClick,
}: WebSyncStatusDotProps) {
  const className = `mini-app-publish-bar__web-sync-dot mini-app-publish-bar__web-sync-dot--${state}${
    spinning ? " mini-app-publish-bar__web-sync-dot--spinning" : ""
  }`;
  const actionBadge = state === "action_required" ? (
    <span className="mini-app-publish-bar__web-sync-dot-badge" aria-hidden>
      !
    </span>
  ) : null;

  if (!interactive) {
    return (
      <span
        className={className}
        title={tooltip}
        aria-label={`App status: ${tooltip}`}
      >
        {spinning ? <WebSyncSpinner /> : null}
        {actionBadge}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={tooltip}
      aria-label={`App status: ${tooltip}`}
      aria-expanded={popoverOpen}
      aria-haspopup="dialog"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
    >
      {spinning ? <WebSyncSpinner /> : null}
      {actionBadge}
    </button>
  );
}
