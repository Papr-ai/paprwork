/**
 * JobPermissionBanner - API key approval or high-frequency agent schedule approval.
 */

import React, { useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { useJobPermissionStore } from "../../stores/jobPermissionStore";

export function JobPermissionBanner() {
  const pending = useJobPermissionStore((s) => s.pending);
  const setPending = useJobPermissionStore((s) => s.setPending);
  const [busy, setBusy] = useState(false);

  if (!pending) return null;

  const isScheduleRisk = Boolean(pending.scheduleRisk);
  const isKeyRequest = Boolean(pending.keys && pending.keys.length > 0);

  async function respondSchedule(approved: boolean): Promise<void> {
    if (!pending?.scheduleRisk || busy) return;
    setBusy(true);
    try {
      await gateway.send("jobs:acknowledge-schedule-risk", {
        jobId: pending.jobId,
        approved,
      });
      setPending(null);
    } catch (error) {
      console.error("[JobPermissionBanner] schedule approval failed:", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`job-permission-banner${isScheduleRisk ? " job-permission-banner--schedule" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="job-permission-banner-icon">
        {isScheduleRisk ? "⚡" : "🔑"}
      </span>
      <span className="job-permission-banner-text">
        {isScheduleRisk && pending.scheduleRisk ? (
          <>
            <strong>{pending.jobName}</strong> — {pending.scheduleRisk.message}
          </>
        ) : isKeyRequest ? (
          <>
            <strong>{pending.jobName}</strong> needs your approval for API
            key(s): {pending.keys?.join(", ")}. Check the permission dialog.
          </>
        ) : (
          <>
            <strong>{pending.jobName}</strong> needs your approval.
          </>
        )}
      </span>
      {isScheduleRisk && (
        <span className="job-permission-banner-actions">
          <button
            type="button"
            className="job-permission-banner-btn job-permission-banner-btn--approve"
            disabled={busy}
            onClick={() => void respondSchedule(true)}
          >
            Approve schedule
          </button>
          <button
            type="button"
            className="job-permission-banner-btn job-permission-banner-btn--deny"
            disabled={busy}
            onClick={() => void respondSchedule(false)}
          >
            Disable schedule
          </button>
        </span>
      )}
    </div>
  );
}
