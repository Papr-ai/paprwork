/**
 * Compact cloud sync indicator for the mini-app publish bar.
 */

import React, { useEffect, useRef, useState } from "react";
import type { AppCloudItemPhase } from "../../utils/appCloudSyncStatus";
import { useAppCloudSyncStatus } from "../../hooks/useAppCloudSyncStatus";

interface AppCloudSyncChipProps {
  appId: string;
}

function StatusIcon({ spinning }: { spinning: boolean }) {
  if (spinning) {
    return (
      <span className="mini-app-publish-bar__sync-chip-spinner" aria-hidden />
    );
  }
  return null;
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

function needsSyncAction(
  status: NonNullable<ReturnType<typeof useAppCloudSyncStatus>["status"]>,
): boolean {
  return status.overall !== "synced";
}

export function AppCloudSyncChip({ appId }: AppCloudSyncChipProps) {
  const { status, loading, refreshing, pushing, error, pushNow } =
    useAppCloudSyncStatus(appId, { enabled: true });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  if (loading || refreshing || !status) {
    return (
      <span
        className="mini-app-publish-bar__sync-chip mini-app-publish-bar__sync-chip--pending"
        title={error ?? "Checking cloud sync"}
      >
        <span>{error ? "Sync unavailable" : "Sync status…"}</span>
      </span>
    );
  }

  if (status.overall === "disabled") {
    return (
      <span
        className="mini-app-publish-bar__sync-chip mini-app-publish-bar__sync-chip--pending"
        title={status.summaryLine}
      >
        <span>Cloud sync off</span>
      </span>
    );
  }

  const chipClass =
    status.overall === "synced"
      ? "mini-app-publish-bar__sync-chip mini-app-publish-bar__sync-chip--synced"
      : status.overall === "uploading"
        ? "mini-app-publish-bar__sync-chip mini-app-publish-bar__sync-chip--syncing"
        : "mini-app-publish-bar__sync-chip mini-app-publish-bar__sync-chip--warn";

  const showSpinner = pushing || status.overall === "uploading";
  const showRefreshPulse = refreshing && !showSpinner;
  const syncActionNeeded = needsSyncAction(status);

  return (
    <div className="mini-app-publish-bar__sync-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className={`${chipClass}${showRefreshPulse ? " mini-app-publish-bar__sync-chip--refreshing" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={status.summaryLine}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusIcon spinning={showSpinner} />
        <span>{status.chipLabel}</span>
      </button>

      {open ? (
        <div
          className="mini-app-publish-bar__sync-popover"
          role="dialog"
          aria-label="Cloud sync details"
        >
          <p className="mini-app-publish-bar__sync-popover-title">
            What&apos;s on the web
          </p>
          <p className="mini-app-publish-bar__sync-popover-summary">
            {status.summaryLine}
          </p>
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
            {status.hasLinkedDatabases ? (
              status.databases.map((db) => (
                <li key={db.jobId}>
                  <span className="mini-app-publish-bar__sync-popover-icon">
                    {rowIcon(db.phase)}
                  </span>
                  <span>
                    <strong>{db.alias}</strong> — {db.detail}
                  </span>
                </li>
              ))
            ) : null}
          </ul>
          {syncActionNeeded ? (
            <p className="mini-app-publish-bar__sync-popover-hint">
              {pushing
                ? "Uploading this app and its linked jobs to GitHub. This usually takes under a minute."
                : status.globallySyncing
                  ? "Sync now uploads this app and its jobs immediately — it does not wait for the background workspace queue."
                  : "Click Sync now to upload this app and its linked jobs."}
            </p>
          ) : (
            <p className="mini-app-publish-bar__sync-popover-hint">
              This app matches what&apos;s on the web — app code, linked jobs, and
              databases are up to date.
            </p>
          )}
          {status.cloudPublishing && status.overall === "synced" ? (
            <p className="mini-app-publish-bar__sync-popover-hint">
              Updating cloud publish config so the web app can use new backend keys.
              Refresh the browser tab when this finishes.
            </p>
          ) : null}
          {status.globallySyncing && status.overall === "synced" ? (
            <p className="mini-app-publish-bar__sync-popover-hint">
              Other workspace files are still syncing in the background.
            </p>
          ) : null}
          {error ? (
            <p className="mini-app-publish-bar__sync-popover-error">{error}</p>
          ) : null}
          {syncActionNeeded || pushing ? (
            <button
              type="button"
              className="mini-app-publish-bar__sync-popover-btn"
              disabled={pushing}
              onClick={() => void pushNow()}
            >
              {pushing ? "Uploading…" : "Sync now"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
