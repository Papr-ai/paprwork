/**
 * Web sync popover and status dot for the mini-app publish bar.
 */

import React from "react";
import { PaprCloudRequirementsPanel } from "../common/PaprCloudRequirementsPanel";
import { requestPaprCloudFeature } from "../../stores/paprCloudFeatureStore";
import type {
  AppCloudItemPhase,
  AppCloudSyncStatus,
  WebSyncVisualState,
} from "../../utils/appCloudSyncStatus";
import {
  formatLastUploadedAt,
  webSyncShouldPullBeforePublish,
} from "../../utils/appCloudSyncStatus";
import {
  buildMergeReviewAgentPrompt,
  buildOversizedFilesAgentPrompt,
  buildSchemaDriftAgentPrompt,
  buildUploadFailureAgentPrompt,
  buildWriterConflictAgentPrompt,
  openCloudSyncAgentChat,
  buildUpdateConflictAgentPrompt,
} from "../../utils/openCloudSyncAgentChat";
/** Primary push action label — Publish in every state (v4: one verb, progress shows what happens). */
export function webSyncPushButtonLabel(options: {
  appLive: boolean;
  pushing: boolean;
}): string {
  if (options.pushing) {
    return "Publishing…";
  }
  return "Publish";
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
  /** Held update with conflicts: Keep mine / Take theirs. */
  onResolveConflict?: (resolution: "take_theirs" | "keep_mine") => void;
  /** False when the app has never been published — primary action is Publish (share + upload). */
  appLive?: boolean;
  /** Per-app: upload to web automatically vs Publish changes only (hint copy only) */
  autoUploadEnabled?: boolean;
  popoverRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  style?: React.CSSProperties;
  needsStatusCheck?: boolean;
  lastCheckedAt?: number | null;
  onCheckStatus?: () => void;
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
  return "The database structure changed locally and isn't on the web yet. Click Publish — if that fails, ask the agent to align it.";
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
  onResolveConflict,
  appLive = true,
  autoUploadEnabled,
  popoverRef,
  className,
  style,
  needsStatusCheck = false,
  lastCheckedAt = null,
  onCheckStatus,
}: WebSyncPopoverProps) {
  const pushIfAllowed = (): void => {
    if (!requestPaprCloudFeature("publish_share")) {
      return;
    }
    onPushNow();
  };
  const busy = pushing || pulling || applyingUpdates || loading || refreshing;
  const pushLabel = webSyncPushButtonLabel({ appLive, pushing });
  const remoteReviewNeeded = status?.gitRemoteRequiresReview === true;
  const writerConflict = status?.writerConflict === true;
  const metadataSync = status?.gitRemoteMetadataSync === true;
  const activelyUploading = status?.overall === "uploading";
  const queuedForUpload = status?.uploadQueued === true;
  const showMergeReview = remoteReviewNeeded && !metadataSync;
  const showWriterConflict = writerConflict && !showMergeReview && !metadataSync;
  const updateConflictFiles = status?.updateConflictFiles ?? [];
  const showUpdateConflict =
    updateConflictFiles.length > 0 && !showMergeReview && !metadataSync && Boolean(onResolveConflict);
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
  const pullBeforePublish =
    status != null && webSyncShouldPullBeforePublish(status);
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
        <PaprCloudRequirementsPanel featureId="publish_share" compact />
        <p className="mini-app-publish-bar__sync-popover-summary">
          {loading || refreshing ? "Checking…" : "Click Check status to compare local vs web."}
        </p>
        {onCheckStatus ? (
          <div className="mini-app-publish-bar__sync-popover-actions">
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => onCheckStatus()}
            >
              {refreshing ? "Checking…" : "Check status"}
            </button>
          </div>
        ) : null}
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
            onClick={() => pushIfAllowed()}
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

  return (
    <div
      ref={popoverRef}
      className={popoverClassName}
      style={style}
      role="dialog"
      aria-label="Web sync"
    >
      <p className="mini-app-publish-bar__sync-popover-title">Web sync</p>

      <PaprCloudRequirementsPanel featureId="publish_share" compact />

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
      ) : pullBeforePublish ? (
        <div
          className="mini-app-publish-bar__sync-remote-banner mini-app-publish-bar__sync-remote-banner--metadata"
          role="status"
        >
          <p className="mini-app-publish-bar__sync-remote-banner-title">
            Web has newer app code
          </p>
          <p className="mini-app-publish-bar__sync-remote-banner-body">
            Get updates before publishing — like pulling on GitHub before you push.
          </p>
        </div>
      ) : showHeadline ? (
        <p className="mini-app-publish-bar__sync-popover-summary">{headlineText}</p>
      ) : null}

      {/* The two halves are different kinds of fact: your copy is watched and
          always current, the web copy is asked every 5 minutes. Naming the
          location of each keeps "checked" from reading as generic freshness. */}
      <dl className="mini-app-publish-bar__sync-sides">
        <div className="mini-app-publish-bar__sync-side">
          <dt>Your copy, on this Mac</dt>
          <dd>
            {status && status.overall !== "synced" && status.overall !== "disabled"
              ? "Edited since last publish"
              : "No unpublished edits"}
          </dd>
        </div>
        <div className="mini-app-publish-bar__sync-side">
          <dt>Web copy, apps.papr.ai</dt>
          <dd>
            {lastCheckedAt
              ? `Checked ${formatLastUploadedAt(new Date(lastCheckedAt).toISOString()) ?? "recently"}`
              : "Not checked yet"}
          </dd>
        </div>
      </dl>
      <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--subtle">
        Your copy is watched and never out of date. Only the web copy is asked, every 5 minutes.
      </p>

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
                Publishing is manual for this app — click <strong>Publish</strong> when you
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
        {/* Only when the number above is actually stale. Once a status is
            loaded this button re-runs the same call as the refresh icon on
            the chip, so offering both made a read-only re-ask look like a
            decision the user had to make on every open. */}
        {onCheckStatus && needsStatusCheck ? (
          <button
            type="button"
            className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
            disabled={busy}
            onClick={() => onCheckStatus()}
          >
            {refreshing ? "Checking…" : "Check status"}
          </button>
        ) : null}
        {showUpdateConflict ? (
          <>
            <p className="mini-app-publish-bar__sync-popover-hint mini-app-publish-bar__sync-popover-hint--warn">
              {updateConflictFiles.slice(0, 3).join(", ")}
              {updateConflictFiles.length > 3 ? ` +${updateConflictFiles.length - 3} more` : ""}
            </p>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={busy}
              onClick={() => onResolveConflict?.("keep_mine")}
            >
              Keep mine
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy}
              onClick={() => {
                if (confirm(`Replace your edits in ${updateConflictFiles.length} file(s) with the update?`)) {
                  onResolveConflict?.("take_theirs");
                }
              }}
            >
              Take theirs
            </button>
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
              disabled={busy}
              onClick={() => openCloudSyncAgentChat(buildUpdateConflictAgentPrompt({ appId, files: updateConflictFiles }))}
            >
              Ask agent to merge
            </button>
          </>
        ) : showWriterConflict ? (
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
              onClick={() => pushIfAllowed()}
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
              onClick={() => pushIfAllowed()}
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
                onClick={() => pushIfAllowed()}
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
              Publish didn't finish — try Publish again. If it keeps failing, ask the agent to look into it.
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
                onClick={() => pushIfAllowed()}
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
            {(syncActionNeeded || pushing || queuedForUpload) &&
            !pullBeforePublish ? (
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
                  onClick={() => pushIfAllowed()}
                >
                  {pushLabel}
                </button>
              </>
            ) : null}
            {/* Only when there is something to get. This merges cloud code
                into the local folder and can raise conflicts — offering it
                against an unchanged remote asked the user to run a git merge
                for no reason. The error branches above still show it
                unconditionally, because there it is part of a recovery. */}
            {status.gitUpdatesAvailable ? (
              <button
                type="button"
                className={`mini-app-publish-bar__sync-popover-btn${
                  pullBeforePublish
                    ? ""
                    : " mini-app-publish-bar__sync-popover-btn--secondary"
                }`}
                disabled={busy || metadataSync || pushing}
                onClick={() => void onPullUpdates()}
              >
                {pulling ? "Getting updates…" : "Get updates"}
              </button>
            ) : null}
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
  /** Worst-first chip text. When present the dot renders as a labelled pill. */
  label?: string;
  /** Semantic colour for the pill — warn is amber, bad is red, ok is green. */
  tone?: "ok" | "warn" | "bad" | "info" | "idle" | "busy";
  /** Re-asks the web. Only offered when the chip is showing an age. */
  onRefresh?: () => void;
  /**
   * Pull/review, carried by the chip rather than the primary slot — the label
   * to the left already names the condition, so this is a glyph at rest and
   * spells out `verb` on hover. Never set at the same time as onRefresh: an
   * aged check only happens when calm, which is exactly when there is no pull.
   */
  action?: {
    glyph: "down" | "open" | "up";
    verb: string;
    onRun: () => void;
  };
}

/** Pull it down. */
function WebSyncDownIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5v13m5-5-5 5-5-5" />
    </svg>
  );
}

/** Send it up — the mirror of pull, used for propose-to-publisher. */
function WebSyncUpIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 19V6m-5 5 5-5 5 5" />
    </svg>
  );
}

/** Go look at it — review is a destination, not a transfer. */
function WebSyncOpenIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 5h5v5M19 5l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

/**
 * Audience as a glyph on the Share button. "Public · Code install" cost about a
 * third of the bar to state something the user only checks before sending a
 * link — a lock/people/globe carries the same distinction at a glance, and the
 * button's tooltip plus the Share sheet still spell it out in full.
 */
export function ShareAudienceIcon({
  loginAccess,
  codeAccess,
}: {
  loginAccess: "private" | "team" | "public" | "none" | null;
  /** When people can fork the source, the audience glyph carries a code badge. */
  codeAccess?: "off" | "install" | null;
}) {
  const path =
    loginAccess === "public"
      ? // Globe
        "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c1.7 1.8 2.6 4.1 2.6 6.5S9.7 12.7 8 14.5c-1.7-1.8-2.6-4.1-2.6-6.5S6.3 3.3 8 1.5Z"
      : loginAccess === "team"
        ? // Two people
          "M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.5 13c0-2 2-3.5 4.5-3.5s4.5 1.5 4.5 3.5M11 3.2a2.25 2.25 0 0 1 0 4.4M12.2 9.8c1.4.5 2.3 1.7 2.3 3.2"
        : // Lock
          "M4.5 7V5.2a3.5 3.5 0 0 1 7 0V7M3.5 7h9v6.5h-9V7Z";
  const audience =
    loginAccess === "public"
      ? "Anyone on the web"
      : loginAccess === "team"
        ? "Your team"
        : "Only you";
  const canFork = codeAccess === "install";
  const label = canFork ? `${audience} · can copy the code` : audience;
  return (
    <span
      className={`mini-app-publish-bar__share-audience${
        canFork ? " mini-app-publish-bar__share-audience--code" : ""
      }`}
      title={label}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {/* Badged, not a second icon: "public AND forkable" is one fact about who
          gets what, and the bar has no room for two glyphs side by side. */}
      {canFork ? (
        <span className="mini-app-publish-bar__share-code-badge" aria-hidden>
          <svg viewBox="0 0 16 16" width="10" height="10" focusable="false">
            <path
              d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

/** Circular arrow — re-ask the web, shown inside the pill next to the age. */
function WebSyncRefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54M13 3v3h-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WebSyncStatusDot({
  state,
  spinning = false,
  tooltip,
  popoverOpen = false,
  interactive = true,
  onClick,
  label,
  tone,
  onRefresh,
  action,
}: WebSyncStatusDotProps) {
  const chip = Boolean(label);
  const className = `mini-app-publish-bar__web-sync-dot mini-app-publish-bar__web-sync-dot--${state}${
    spinning ? " mini-app-publish-bar__web-sync-dot--spinning" : ""
  }${chip ? " mini-app-publish-bar__web-sync-dot--chip" : ""}${
    chip && tone ? ` mini-app-publish-bar__web-sync-dot--tone-${tone}` : ""
  }`;

  // Labelled pill: one object carrying state, age, and the control that
  // refreshes that age — so the number and its refresh never drift apart.
  if (chip) {
    // No title on the wrapper. It spans the dot, the label, the refresh button
    // and the padding between them, so a tooltip there fired over dead gray
    // area where the cursor is an arrow and nothing is clickable. The status
    // sentence belongs to the status button only.
    return (
      <span className={className}>
        <button
          type="button"
          className={`mini-app-publish-bar__web-sync-chip-main${
            interactive ? "" : " mini-app-publish-bar__web-sync-chip-main--inert"
          }`}
          title={tooltip}
          aria-label={`App status: ${tooltip}`}
          aria-expanded={popoverOpen}
          aria-haspopup="dialog"
          // aria-disabled, not disabled: a truly disabled button fires no
          // pointer events, so it can never show its own tooltip — which is
          // what pushed the title onto the wrapper in the first place. The
          // click is guarded below instead.
          aria-disabled={!interactive}
          onClick={(event) => {
            event.stopPropagation();
            if (!interactive) return;
            onClick?.();
          }}
        >
          <span className="mini-app-publish-bar__web-sync-chip-dot" aria-hidden />
          {spinning ? <WebSyncSpinner /> : null}
          <span className="mini-app-publish-bar__web-sync-chip-text">{label}</span>
        </button>
        {/* Action and refresh share one pill treatment so the chip has a
            single kind of trailing control. They cannot collide: refresh is
            only offered on an aged calm check, which is exactly the state
            with no pull available. */}
        {action ? (
          <button
            type="button"
            className="mini-app-publish-bar__web-sync-chip-act"
            aria-label={action.verb}
            onClick={(event) => {
              event.stopPropagation();
              action.onRun();
            }}
          >
            {action.glyph === "down" ? (
              <WebSyncDownIcon />
            ) : action.glyph === "up" ? (
              <WebSyncUpIcon />
            ) : (
              <WebSyncOpenIcon />
            )}
            {/* Present at all times, collapsed to zero width rather than
                hidden — so it animates open on approach and screen readers
                always reach it. A native title tooltip waits ~1s and lands
                away from the cursor, too late to help someone deciding
                whether this is the thing to click. */}
            <span className="mini-app-publish-bar__web-sync-chip-act-verb">
              {action.verb}
            </span>
          </button>
        ) : onRefresh ? (
          <button
            type="button"
            className="mini-app-publish-bar__web-sync-chip-act"
            aria-label="Re-check the web copy now"
            onClick={(event) => {
              event.stopPropagation();
              onRefresh();
            }}
          >
            <WebSyncRefreshIcon />
            <span className="mini-app-publish-bar__web-sync-chip-act-verb">
              Check now
            </span>
          </button>
        ) : null}
      </span>
    );
  }
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
