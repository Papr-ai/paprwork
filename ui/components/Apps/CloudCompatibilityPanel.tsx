import React from "react";
import type { CloudCompatibilityReport } from "../../src/core/types/cloudAppCompatibility";

export function cloudCompatibilityLabel(level: CloudCompatibilityReport["level"]): string {
  switch (level) {
    case "cloud-ready":
      return "Cloud ready";
    case "hybrid":
      return "Hybrid";
    case "desktop-only":
      return "Desktop only";
  }
}

interface CloudCompatibilityBadgeProps {
  report: CloudCompatibilityReport | null;
  loading?: boolean;
}

export function CloudCompatibilityBadge({
  report,
  loading = false,
}: CloudCompatibilityBadgeProps) {
  if (loading) {
    return (
      <span className="cloud-compat-badge cloud-compat-badge--loading">
        Checking cloud…
      </span>
    );
  }
  if (!report) return null;

  return (
    <span
      className={`cloud-compat-badge cloud-compat-badge--${report.level}`}
      title={report.summary}
    >
      {cloudCompatibilityLabel(report.level)}
    </span>
  );
}

interface CloudCompatibilityPanelProps {
  report: CloudCompatibilityReport | null;
  loading?: boolean;
  showConfirm?: boolean;
  onConfirmPublish?: () => void;
  confirmBusy?: boolean;
}

export function CloudCompatibilityPanel({
  report,
  loading = false,
  showConfirm = false,
  onConfirmPublish,
  confirmBusy = false,
}: CloudCompatibilityPanelProps) {
  if (loading) {
    return (
      <div className="share-sheet__notice share-sheet__notice--info">
        <p>Scanning app for cloud compatibility…</p>
      </div>
    );
  }
  if (!report) return null;

  const noticeClass =
    report.level === "cloud-ready"
      ? "share-sheet__notice share-sheet__notice--success"
      : report.level === "hybrid"
        ? "share-sheet__notice share-sheet__notice--info"
        : "share-sheet__notice share-sheet__notice--warn";

  const topFindings = report.findings
    .filter((f) => f.severity !== "info")
    .slice(0, 5);

  return (
    <div className="share-sheet__section">
      <p className="share-sheet__section-title">Cloud compatibility</p>
      <div className={noticeClass}>
        <p>
          <strong>{cloudCompatibilityLabel(report.level)}.</strong> {report.summary}
        </p>
      </div>

      {report.cloudWorks.length > 0 ? (
        <div className="cloud-compat-panel__list-block">
          <p className="cloud-compat-panel__list-title">Works on apps.papr.ai</p>
          <ul className="cloud-compat-panel__list">
            {report.cloudWorks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.desktopOnly.length > 0 ? (
        <div className="cloud-compat-panel__list-block">
          <p className="cloud-compat-panel__list-title">Needs Paprwork desktop</p>
          <ul className="cloud-compat-panel__list">
            {report.desktopOnly.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {topFindings.length > 0 ? (
        <details className="cloud-compat-panel__details">
          <summary>Technical details ({topFindings.length})</summary>
          <ul className="cloud-compat-panel__findings">
            {topFindings.map((finding) => (
              <li key={`${finding.file}:${finding.line ?? 0}:${finding.message}`}>
                <span className="cloud-compat-panel__finding-file">
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ""}
                </span>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {showConfirm && report.requiresAcknowledgement ? (
        <div className="cloud-compat-panel__confirm">
          <p>
            Visitors on <strong>apps.papr.ai</strong> will not get working automation. Publish
            anyway for a read-only dashboard or team visibility?
          </p>
          <button
            type="button"
            className="share-sheet__primary-btn"
            disabled={confirmBusy}
            onClick={onConfirmPublish}
          >
            Publish desktop-only app
          </button>
        </div>
      ) : null}
    </div>
  );
}
