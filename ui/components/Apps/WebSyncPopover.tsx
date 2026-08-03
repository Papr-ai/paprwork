/**
 * Web sync popover and status dot for the mini-app publish bar.
 */

import React from "react";
import type {
  AppCloudItemPhase,
  AppCloudSyncStatus,
  WebSyncVisualState,
} from "../../utils/appCloudSyncStatus";

export interface WebSyncPopoverProps {
  status: AppCloudSyncStatus;
  error: string | null;
  pushing: boolean;
  pulling: boolean;
  syncActionNeeded: boolean;
  onPushNow: () => void;
  onPullUpdates: () => void;
}

function rowIcon(phase: AppCloudItemPhase): string {
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

export function WebSyncPopover({
  status,
  error,
  pushing,
  pulling,
  syncActionNeeded,
  onPushNow,
  onPullUpdates,
}: WebSyncPopoverProps) {
  const busy = pushing || pulling;
  return (
    <div
      className="mini-app-publish-bar__sync-popover"
      role="dialog"
      aria-label="Web sync details"
    >
      <p className="mini-app-publish-bar__sync-popover-title">What&apos;s on the web</p>
      <p className="mini-app-publish-bar__sync-popover-summary">{status.summaryLine}</p>
      <ul className="mini-app-publish-bar__sync-popover-list">
        <li>
          <span className="mini-app-publish-bar__sync-popover-icon">
            {rowIcon(status.codePhase)}
          </span>
          <span>
            <strong>App code</strong> — {status.codeLabel}
          </span>
        </li>
        {status.hasDependentJobs ? (
          status.dependentJobs.map((job) => (
            <li key={job.jobId}>
              <span className="mini-app-publish-bar__sync-popover-icon">
                {rowIcon(job.phase)}
              </span>
              <span>
                <strong>{job.label}</strong> — {job.detail}
              </span>
            </li>
          ))
        ) : (
          <li>
            <span className="mini-app-publish-bar__sync-popover-icon">·</span>
            <span>No linked jobs</span>
          </li>
        )}
        {status.hasLinkedDatabases
          ? status.databases.map((db) => (
              <li key={db.jobId}>
                <span className="mini-app-publish-bar__sync-popover-icon">
                  {rowIcon(db.phase)}
                </span>
                <span>
                  <strong>{db.alias}</strong> — {db.detail}
                </span>
              </li>
            ))
          : null}
      </ul>
      {syncActionNeeded ? (
        <p className="mini-app-publish-bar__sync-popover-hint">
          {pushing
            ? "Uploading this app and its linked jobs to the cloud. This usually takes under a minute."
            : status.globallySyncing
              ? "Upload now sends this app immediately — it does not wait for the background workspace queue."
              : "Upload now sends your local app code and database changes to the cloud."}
        </p>
      ) : (
        <p className="mini-app-publish-bar__sync-popover-hint">
          This app matches what&apos;s on the web — app code, linked jobs, and databases are
          up to date.
        </p>
      )}
      <p className="mini-app-publish-bar__sync-popover-hint">
        {pulling
          ? "Getting the latest app code and database rows from the cloud…"
          : "Get updates downloads the latest code and database rows from teammates or cloud jobs."}
      </p>
      {status.cloudPublishing && status.overall === "synced" ? (
        <p className="mini-app-publish-bar__sync-popover-hint">
          Updating cloud publish config so the web app can use new backend keys. Refresh the
          browser tab when this finishes.
        </p>
      ) : null}
      {status.globallySyncing && status.overall === "synced" ? (
        <p className="mini-app-publish-bar__sync-popover-hint">
          Other workspace files are still syncing in the background.
        </p>
      ) : null}
      {error ? <p className="mini-app-publish-bar__sync-popover-error">{error}</p> : null}
      <div className="mini-app-publish-bar__sync-popover-actions">
        <button
          type="button"
          className="mini-app-publish-bar__sync-popover-btn mini-app-publish-bar__sync-popover-btn--secondary"
          disabled={busy}
          onClick={() => void onPullUpdates()}
        >
          {pulling ? "Getting updates…" : "Get updates"}
        </button>
        {syncActionNeeded || pushing ? (
          <button
            type="button"
            className="mini-app-publish-bar__sync-popover-btn"
            disabled={busy}
            onClick={() => void onPushNow()}
          >
            {pushing ? "Uploading…" : "Upload now"}
          </button>
        ) : null}
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
  popoverOpen: boolean;
  onClick: () => void;
}

export function WebSyncStatusDot({
  state,
  spinning = false,
  tooltip,
  popoverOpen,
  onClick,
}: WebSyncStatusDotProps) {
  return (
    <button
      type="button"
      className={`mini-app-publish-bar__web-sync-dot mini-app-publish-bar__web-sync-dot--${state}${
        spinning ? " mini-app-publish-bar__web-sync-dot--spinning" : ""
      }`}
      title={tooltip}
      aria-label={`Web sync: ${tooltip}`}
      aria-expanded={popoverOpen}
      aria-haspopup="dialog"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {spinning ? <WebSyncSpinner /> : null}
    </button>
  );
}
