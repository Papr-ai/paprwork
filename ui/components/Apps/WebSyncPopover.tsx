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
  buildOversizedFilesAgentPrompt,
  buildSchemaDriftAgentPrompt,
  buildUploadFailureAgentPrompt,
  buildWriterConflictAgentPrompt,
  openCloudSyncAgentChat,
} from "../../utils/openCloudSyncAgentChat";
import { AUTO_UPLOAD_TOGGLE_LABEL } from "../../utils/appUploadMode";

/** Primary push action label — Publish for first-time web deploy, Publish changes when already live. */
export function webSyncPushButtonLabel(options: {
  appLive: boolean;
  pushing: boolean;
}): string {
  if (options.pushing) {
    return "Publishing…";
  }
  return options.appLive ? "Publish changes" : "Publish";
}

/**
 * "Ask agent" is offered whenever the app is not simply synced — anything
 * that did not resolve on its own (stuck, pending after a publish attempt,
 * updates the user can't merge, unknown) is something the agent can
 * diagnose. Never shown for synced / disabled / actively publishing.
 */
export function webSyncShouldOfferAgent(
  status: AppCloudSyncStatus | null,
  options: { error?: string | null; pushing?: boolean; pulling?: boolean },
): boolean {
  if (options.error) return true;
  if (!status) return false;
  if (options.pushing || options.pulling) return false;
  if (status.overall === "synced" || status.overall === "disabled") return false;
  if (status.overall === "uploading") return false;
  return true;
}

export function buildGenericSyncAgentPrompt(input: {
  appId?: string;
  status: AppCloudSyncStatus;
}): string {
  const s = input.status;
  const parts = [
    "Help me get my Papr mini-app fully published to the web.",
    `Current status: ${s.chipLabel} — ${s.summaryLine}`,
  ];
  if (input.appId) parts.push(`App id: ${input.appId}.`);
  if (s.codeLabel) parts.push(`App code: ${s.codeLabel}`);
  for (const job of s.dependentJobs) {
    if (job.phase !== "synced") parts.push(`Job "${job.label}": ${job.detail}`);
  }
  for (const db of s.databases) {
    if (db.phase !== "synced" || db.rowsSyncing) {
      parts.push(`Database "${db.alias}": ${db.detail}`);
      if (db.lastReplicaPushError) parts.push(`  raw error: ${db.lastReplicaPushError}`);
      if (db.cutoverBlockReason) parts.push(`  raw reason: ${db.cutoverBlockReason}`);
    }
  }
  if (s.codeLastError) parts.push(`Last code error: ${s.codeLastError}`);
  parts.push(
    "Use get_cloud_sync_status({ appId }) and papr_db_sync_status to diagnose, fix what you can, then tell me what changed.",
  );
  return parts.join("\n");
}

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
  /** False when the app has never been published — primary action is Publish (share + upload). */
  appLive?: boolean;
  /** Per-app: upload to web automatically vs Publish changes only */
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

function isDatabaseSyncBlocker(db: AppCloudSyncStatus["databases"][number]): boolean {
  return (
    db.schemaDrift === true ||
    db.migrationConflict === true ||
    db.cutoverBlocked === true
  );
}

function databaseBlockerHint(
  databases: AppCloudSyncStatus["databases"],
): string | null {
  const blocked = databases.filter(isDatabaseSyncBlocker);
  if (blocked.length === 0) {
    return null;
  }
  // Plain-language first; technical reason stays on the database row's
  // detail / raw error fields for anyone who wants it.
  if (blocked.some((db) => db.cutoverBlocked)) {
    return "One of this app's databases can't publish until its structure is fixed. Ask the agent to repair it, then publish again.";
  }
  if (blocked.some((db) => db.migrationConflict)) {
    return "Your local database and the web version have different structures. Ask the agent to reconcile them, then publish again.";
  }
  return "The database structure changed locally and isn't on the web yet. Click Publish changes — if that fails, ask the agent to align it.";
}

function resolveUploadFailureMessage(
  error: string | null,
  status: AppCloudSyncStatus | null,
): string | null {
  const fromHook = error?.trim();
  if (fromHook) {
    return fromHook;
  }
  if (!status) {
    return null;
  }
  if (status.uploadStatus === "failed" && !status.uploadRetryPending) {
    return (
      status.uploadDetail?.trim() ||
      status.uploadLabel?.trim() ||
      "Publish failed"
    );
  }
  const replicaDbError = status.databases.find(
    (db) => db.lastReplicaPushError?.trim(),
  )?.lastReplicaPushError;
  if (replicaDbError?.trim()) {
    return replicaDbError.trim();
  }
  return status.codeLastError?.trim() || null;
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
  appLive = true,
  autoUploadEnabled,
  autoUploadUsesGlobalDefault = false,
  autoUploadSaving = false,
  onAutoUploadChange,
  popoverRef,
  className,
  style,
}: WebSyncPopoverProps) {
  const busy = pushing || pulling || applyingUpdates || loading || refreshing || autoUploadSaving;
  const pushLabel = webSyncPushButtonLabel({ appLive, pushing });
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
  const hasDatabaseBlockers =
    status?.databases.some(isDatabaseSyncBlocker) === true;
  const showDatabaseBlockerHelp =
    (schemaDriftBlocked || hasDatabaseBlockers) &&
    !showMergeReview &&
    !showWriterConflict &&
    !metadataSync;
  const uploadFailureMessage = resolveUploadFailureMessage(error, status);
  const showUploadFailureHelp =
    Boolean(uploadFailureMessage) &&
    !showMergeReview &&
    !showWriterConflict &&
    !showDatabaseBlockerHelp &&
    !metadataSync;
  const hasOversizedFiles = (status?.oversizedAppFilesCount ?? 0) > 0;
  const showOversizedFilesHelp =
    hasOversizedFiles &&
    !showMergeReview &&
    !showWriterConflict &&
    !showDatabaseBlockerHelp &&
    !showUploadFailureHelp &&
    !metadataSync;
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
  // shell with Publish changes rather than rendering nothing on click.
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
        {uploadFailureMessage ? (
          <p className="mini-app-publish-bar__sync-popover-error">{uploadFailureMessage}</p>
        ) : null}
        <div className="mini-app-publish-bar__sync-popover-actions">
          {uploadFailureMessage ? (
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildUploadFailureAgentPrompt({
                    appId,
                    error: uploadFailureMessage,
                  }),
                );
              }}
            >
              Ask agent
            </button>
          ) : null}
          <button
            type="button"
            className={`mini-app-publish-bar__sync-popover-btn${
              uploadFailureMessage
                ? " mini-app-publish-bar__sync-popover-btn--secondary"
                : ""
            }`}
            disabled={busy}
            onClick={() => void onPushNow()}
          >
            {pushLabel}
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

  if (status.oversizedAppFilesCount && status.oversizedAppFilesCount > 0) {
    statusRows.push({
      key: "oversized-files",
      icon: "⚠",
      label: "Large files skipped",
      detail: shortDetail(
        status.oversizedAppFilesMessage ??
          `${status.oversizedAppFilesCount} file(s) over 10MB — use App Files`,
        120,
      ),
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
            Merge cloud changes before publishing
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
            Get updates or ask the agent to reconcile remote changes, then publish again.
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
        {status.codeLastError && status.codeLastError !== uploadFailureMessage ? (
          <p className="mini-app-publish-bar__sync-popover-error">{status.codeLastError}</p>
        ) : null}
        {status.overall === "disabled" ? (
          <p className="mini-app-publish-bar__sync-popover-hint">
            Turn on cloud sync in Settings.
          </p>
        ) : null}
        {!autoUploadEnabled && status.overall !== "synced" && status.overall !== "disabled" ? (
          <p className="mini-app-publish-bar__sync-popover-hint">
            {appLive ? (
              <>
                Publishing is manual for this app — click <strong>Publish changes</strong> when you
                want local changes on the web. After sharing changes, wait until this panel
                shows synced before copying the external link.
              </>
            ) : (
              <>
                This app is not on the web yet — click <strong>Publish</strong> to publish
                code and databases and create your link (uses your current Share settings).
              </>
            )}
          </p>
        ) : null}
        {appLive === false &&
        autoUploadEnabled &&
        status.overall !== "synced" &&
        status.overall !== "disabled" ? (
          <p className="mini-app-publish-bar__sync-popover-hint">
            Not on the web yet — click <strong>Publish</strong> once; later changes publish
            automatically.
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
              ? `Last published ${formatLastUploadedAt(status.lastUploadedAt) ?? "recently"}.`
              : "Everything matches the web."}
          </p>
        ) : null}
        {status.oversizedAppFilesCount && status.oversizedAppFilesCount > 0 ? (
          <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
            Move large files to App Files (panel beside Data Sources). Git sync skips
            files over 10MB — visitors will not see assets left in the app folder. Ask
            agent can relocate them for you.
          </p>
        ) : null}
        {uploadFailureMessage ? (
          <p className="mini-app-publish-bar__sync-popover-error">{uploadFailureMessage}</p>
        ) : null}
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
              {pushLabel}
            </button>
          </>
        ) : showDatabaseBlockerHelp ? (
          <>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildSchemaDriftAgentPrompt({
                    appId,
                    databases: status.databases.filter(isDatabaseSyncBlocker),
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
              {pushLabel}
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync || pushing}
              onClick={() => void onPullUpdates()}
            >
              {pulling ? "Getting updates…" : "Get updates"}
            </button>
            {databaseBlockerHint(status.databases) ? (
              <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
                {databaseBlockerHint(status.databases)}
              </p>
            ) : error ? (
              <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
                Publishing did not clear the database blocker — try Ask agent to diagnose.
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
                {pushLabel}
              </button>
            )}
          </>
        ) : showUploadFailureHelp ? (
          <>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildUploadFailureAgentPrompt({
                    appId,
                    error: uploadFailureMessage,
                    databases: status.databases,
                    uploadDetail: status.uploadDetail,
                    codeLastError: status.codeLastError,
                  }),
                );
              }}
            >
              Ask agent
            </button>
            {(syncActionNeeded || pushing || queuedForUpload) && (
              <button
                type="button"
                className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
                disabled={busy || metadataSync}
                onClick={() => void onPushNow()}
              >
                {pushLabel}
              </button>
            )}
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync || pushing}
              onClick={() => void onPullUpdates()}
            >
              {pulling ? "Getting updates…" : "Get updates"}
            </button>
            <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
              Publish didn't finish — try Publish changes again. If it keeps failing, ask the agent to look into it.
            </p>
          </>
        ) : showOversizedFilesHelp ? (
          <>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => {
                openCloudSyncAgentChat(
                  buildOversizedFilesAgentPrompt({
                    appId,
                    message: status.oversizedAppFilesMessage,
                    count: status.oversizedAppFilesCount,
                  }),
                );
              }}
            >
              Ask agent
            </button>
            {(syncActionNeeded || pushing || queuedForUpload) && (
              <button
                type="button"
                className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
                disabled={busy || metadataSync}
                onClick={() => void onPushNow()}
              >
                {pushLabel}
              </button>
            )}
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy || metadataSync || pushing}
              onClick={() => void onPullUpdates()}
            >
              {pulling ? "Getting updates…" : "Get updates"}
            </button>
            <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
              Large files will not reach the web — Ask agent can move them to App Files
              or fix linked database paths.
            </p>
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
                  {pushLabel}
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
            {webSyncShouldOfferAgent(status, { error, pushing, pulling }) ? (
              <button
                type="button"
                className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
                disabled={busy}
                onClick={() => {
                  openCloudSyncAgentChat(
                    buildGenericSyncAgentPrompt({ appId, status }),
                  );
                }}
              >
                Ask agent
              </button>
            ) : null}
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
