/**
 * JobPermissionBanner - Shown when a job started from chat is waiting for API key approval.
 *
 * Surfaces the permission request in chat so users see it even if the modal
 * is behind another window. Clear copy and CTA.
 */

import React from "react";
import { useJobPermissionStore } from "../../stores/jobPermissionStore";

export function JobPermissionBanner() {
  const pending = useJobPermissionStore((s) => s.pending);
  if (!pending) return null;

  return (
    <div className="job-permission-banner" role="status" aria-live="polite">
      <span className="job-permission-banner-icon">🔑</span>
      <span className="job-permission-banner-text">
        <strong>{pending.jobName}</strong> needs your approval for API key(s):{" "}
        {pending.keys.join(", ")}. Check the permission dialog.
      </span>
    </div>
  );
}
