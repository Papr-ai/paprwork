import React, { useState } from "react";
import type { CloudCompatibilityReport } from "../../src/core/types/cloudAppCompatibility";
import { openPaprPlanSettings } from "../../utils/cloudMemoryStatus";
import { useCloudMemoryStatusStore } from "../../stores/cloudMemoryStatusStore";
import "./SyncStatusPanel.css";

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

function cloudCompatibilityBadgeClass(
  level: CloudCompatibilityReport["level"],
): string {
  switch (level) {
    case "cloud-ready":
      return "cloud-compat-badge--cloud-ready";
    case "hybrid":
      return "cloud-compat-badge--hybrid";
    case "desktop-only":
      return "cloud-compat-badge--desktop-only";
  }
}

/** Drop the level prefix ("Hybrid app — …") so we do not repeat the badge label. */
export function compatibilityDetailText(summary: string): string {
  const sep = summary.indexOf(" — ");
  return sep >= 0 ? summary.slice(sep + 3) : summary;
}

/** One line for Share live summary — not the full publish gate. */
export function cloudCompatibilityShareHint(
  report: CloudCompatibilityReport | null,
): string | null {
  if (!report || report.level === "cloud-ready") return null;
  return `${cloudCompatibilityLabel(report.level)} on web — ${compatibilityDetailText(report.summary)}`;
}

const CLOUD_BULLET_SHORT: Record<string, string> = {
  "Dashboard and read-only data via /api/db/* on apps.papr.ai":
    "Read-only data via /api/db on the web",
  "Read-only dashboard data may still load on apps.papr.ai":
    "Dashboard may still load read-only on the web",
  "Features calling localhost:18789 instead of same-origin APIs":
    "Uses local gateway (localhost), not cloud APIs",
  "Direct /api/bash/run from the mini-app iframe (use jobs or backend instead)":
    "Direct bash from iframe — use jobs or backend in cloud",
  "Desktop paprAPI (shell, dialog, notifications — chat.open works in cloud)":
    "Desktop paprAPI — chat.open still works in cloud",
  "Local Chrome CDP (chrome-manager, :9222) — not cloud Playwright":
    "Local Chrome automation — not cloud Playwright",
};

function shortenBullet(text: string): string {
  return CLOUD_BULLET_SHORT[text] ?? text;
}

function formatFindingLocation(file: string, line?: number): string {
  const base = file.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : file;
  return line ? `${base}:${line}` : base;
}

function compatModalSubtitle(level: CloudCompatibilityReport["level"]): string {
  switch (level) {
    case "cloud-ready":
      return "Ready for apps.papr.ai";
    case "hybrid":
      return "Some features on web · rest need Paprwork";
    case "desktop-only":
      return "Visibility on web · full app needs Paprwork";
  }
}

function CompatGlyph({ kind }: { kind: "globe" | "web" | "desktop" | "issue" }) {
  const paths: Record<typeof kind, React.ReactNode> = {
    globe: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M2.5 8h11M8 2.5c1.8 2 1.8 9 0 11M8 2.5c-1.8 2-1.8 9 0 11" />
      </>
    ),
    web: (
      <>
        <ellipse cx="8" cy="4" rx="5" ry="1.8" />
        <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
      </>
    ),
    desktop: (
      <>
        <rect x="2.5" y="3.5" width="11" height="7.5" rx="1.2" />
        <path d="M5.5 14h5" />
      </>
    ),
    issue: <path d="M8 5v3.5M8 11h.01M2.5 13.5h11L8 2.5z" />,
  };
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[kind]}
    </svg>
  );
}

function CompatExpandRow<T>({
  tone,
  icon,
  title,
  value,
  items,
  renderItem,
}: {
  tone: "info" | "warn" | "bad";
  icon: "web" | "desktop" | "issue";
  title: string;
  value: string;
  items: readonly T[];
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const n = items.length;
  if (n === 0) return null;
  return (
    <div className={`sync7-row sync7-row--${tone}`}>
      <span className="sync7-ico">
        <CompatGlyph kind={icon} />
      </span>
      <span className="sync7-txt">
        <span className="sync7-tt">
          <b>{title}</b>
          <small>{value}</small>
        </span>
        <div className="sync7-more">
          <button
            type="button"
            className="sync7-more-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : `Show all ${n}`}
          </button>
          {open ? (
            <div className="sync7-grp">
              {items.map((item, index) => renderItem(item, index))}
            </div>
          ) : null}
        </div>
      </span>
    </div>
  );
}

function collectPanelFindings(report: CloudCompatibilityReport) {
  const topFindings = report.findings.filter((f) => f.severity !== "info").slice(0, 8);
  return topFindings.filter((finding, index, list) => {
    const key = `${finding.file}:${finding.line ?? 0}:${finding.message}`;
    return list.findIndex((f) => `${f.file}:${f.line ?? 0}:${f.message}` === key) === index;
  });
}

function CloudCompatibilityModalPanel({
  report,
  showConfirm,
  onConfirmPublish,
  onCancel,
  confirmBusy,
}: {
  report: CloudCompatibilityReport;
  showConfirm: boolean;
  onConfirmPublish?: () => void;
  onCancel?: () => void;
  confirmBusy: boolean;
}) {
  const uniqueFindings = collectPanelFindings(report);
  const webCount = report.cloudWorks.length;
  const desktopCount = report.desktopOnly.length;
  const headlineTone =
    report.level === "cloud-ready" ? "info" : report.level === "hybrid" ? "warn" : "bad";

  return (
    <div className="compat7">
      <div className={`sync7-row sync7-row--${headlineTone}`}>
        <span className="sync7-ico">
          <CompatGlyph kind="globe" />
        </span>
        <span className="sync7-txt">
          <span className="sync7-tt">
            <b>{cloudCompatibilityLabel(report.level)}</b>
            <small>{compatModalSubtitle(report.level)}</small>
          </span>
        </span>
      </div>

      <CompatExpandRow
        tone="info"
        icon="web"
        title="On apps.papr.ai"
        value={
          webCount === 0
            ? "Nothing detected for web"
            : `${webCount} feature${webCount === 1 ? "" : "s"}`
        }
        items={report.cloudWorks}
        renderItem={(item) => (
          <div key={String(item)} className="sync7-file">
            <code title={String(item)}>{shortenBullet(String(item))}</code>
          </div>
        )}
      />

      <CompatExpandRow
        tone="warn"
        icon="desktop"
        title="Paprwork desktop"
        value={
          desktopCount === 0
            ? "No desktop-only blockers listed"
            : `${desktopCount} feature${desktopCount === 1 ? "" : "s"}`
        }
        items={report.desktopOnly}
        renderItem={(item) => (
          <div key={String(item)} className="sync7-file">
            <code title={String(item)}>{shortenBullet(String(item))}</code>
          </div>
        )}
      />

      <CompatExpandRow
        tone="bad"
        icon="issue"
        title="Scanner findings"
        value={
          uniqueFindings.length === 0
            ? "No issues"
            : `${uniqueFindings.length} issue${uniqueFindings.length === 1 ? "" : "s"}`
        }
        items={uniqueFindings}
        renderItem={(f) => (
          <div
            key={`${f.file}:${f.line ?? 0}:${f.message}`}
            className="sync7-file"
          >
            <code title={f.file}>{formatFindingLocation(f.file, f.line)}</code>
            <span className="sync7-chg">{f.message}</span>
          </div>
        )}
      />

      {showConfirm && report.requiresAcknowledgement ? (
        <div className="sync7-foot compat7-foot">
          <button
            type="button"
            className="sync7-link"
            disabled={confirmBusy}
            onClick={onCancel}
          >
            Not now
          </button>
          <button
            type="button"
            className="sync7-act sync7-act--primary"
            disabled={confirmBusy}
            onClick={onConfirmPublish}
          >
            Publish anyway
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface CloudCompatibilityBadgeProps {
  report: CloudCompatibilityReport | null;
  loading?: boolean;
}

export function CloudCompatibilityBadge({
  report,
  loading = false,
}: CloudCompatibilityBadgeProps) {
  const cloudStatus = useCloudMemoryStatusStore((state) => state.status);

  if (loading) {
    return (
      <span className="cloud-compat-badge cloud-compat-badge--loading">
        Checking cloud…
      </span>
    );
  }

  if (cloudStatus?.level === "paused") {
    return (
      <button
        type="button"
        className="cloud-compat-badge cloud-compat-badge--paused"
        title={cloudStatus.detail}
        onClick={openPaprPlanSettings}
      >
        Papr Cloud paused
      </button>
    );
  }

  // Compatibility levels no longer badge the bar. "Hybrid" and "Desktop only"
  // are publish-time facts, and they are already stated where they matter: the
  // blocking publish gate on the bar before a desktop-only publish. A
  // permanent word next to the app name spent real width on a caveat the user
  // can act on only at publish time.
  //
  // Paused is different and stays: it is billing state, not app state, and it
  // is the only place in the app flow that surfaces it.
  return null;
}

interface CloudCompatibilityPanelProps {
  report: CloudCompatibilityReport | null;
  loading?: boolean;
  showConfirm?: boolean;
  onConfirmPublish?: () => void;
  onCancel?: () => void;
  confirmBusy?: boolean;
  /** Modal publish review — side-by-side actions, no full-width primary. */
  variant?: "inline" | "modal";
}

export function CloudCompatibilityPanel({
  report,
  loading = false,
  showConfirm = false,
  onConfirmPublish,
  onCancel,
  confirmBusy = false,
  variant = "inline",
}: CloudCompatibilityPanelProps) {
  if (loading) {
    return <p className="ss6-note ss6-note--flush">Scanning for cloud compatibility…</p>;
  }
  if (!report) return null;

  if (variant === "modal") {
    return (
      <CloudCompatibilityModalPanel
        report={report}
        showConfirm={showConfirm}
        onConfirmPublish={onConfirmPublish}
        onCancel={onCancel}
        confirmBusy={confirmBusy}
      />
    );
  }

  const uniqueFindings = collectPanelFindings(report);

  const webCount = report.cloudWorks.length;
  const desktopCount = report.desktopOnly.length;
  const showWorksWhere = webCount + desktopCount > 0;

  const alertTone =
    report.level === "cloud-ready"
      ? "ss6-alert"
      : report.level === "hybrid"
        ? "ss6-alert ss6-alert--warn"
        : "ss6-alert ss6-alert--warn";

  return (
    <div className={`ss6-compat${variant === "modal" ? " ss6-compat--modal" : ""}`}>
      <div className={`${alertTone} ss6-compat__alert`}>
        <span>
          <span className={`cloud-compat-badge ${cloudCompatibilityBadgeClass(report.level)}`}>
            {cloudCompatibilityLabel(report.level)}
          </span>{" "}
          {compatibilityDetailText(report.summary)}
        </span>
      </div>

      {showWorksWhere ? (
        <details className="ss6-compat__details">
          <summary className="ss6-compat__summary">
            What works where
            <span className="ss6-compat__summary-meta">
              {webCount > 0 ? `${webCount} on web` : null}
              {webCount > 0 && desktopCount > 0 ? " · " : null}
              {desktopCount > 0 ? `${desktopCount} desktop` : null}
            </span>
          </summary>
          <div className="ss6-compat__split">
            {webCount > 0 ? (
              <div className="ss6-compat__group">
                <p className="ss6-compat__group-label">apps.papr.ai</p>
                <ul className="ss6-compat__bullets">
                  {report.cloudWorks.map((item) => (
                    <li key={item}>{shortenBullet(item)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {desktopCount > 0 ? (
              <div className="ss6-compat__group">
                <p className="ss6-compat__group-label">Paprwork desktop</p>
                <ul className="ss6-compat__bullets">
                  {report.desktopOnly.map((item) => (
                    <li key={item}>{shortenBullet(item)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      {uniqueFindings.length > 0 ? (
        <details className="ss6-compat__details">
          <summary className="ss6-compat__summary">
            Issues in this app
            <span className="ss6-compat__summary-meta">{uniqueFindings.length}</span>
          </summary>
          <ul className="ss6-compat__issues">
            {uniqueFindings.map((finding) => (
              <li
                key={`${finding.file}:${finding.line ?? 0}:${finding.message}`}
                className="ss6-compat__issue"
              >
                <code className="ss6-compat__loc">
                  {formatFindingLocation(finding.file, finding.line)}
                </code>
                <span className="ss6-compat__issue-msg">{finding.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {showConfirm && report.requiresAcknowledgement ? (
        <div
          className={`ss6-compat__confirm${
            variant === "modal" ? " ss6-compat__confirm--modal" : ""
          }`}
        >
          <p className="ss6-hint ss6-hint--flush">
            Publish anyway for a read-only dashboard or team visibility on{" "}
            <strong>apps.papr.ai</strong>?
          </p>
          {variant === "modal" ? (
            <div className="ss6-compat__confirm-actions">
              <button
                type="button"
                className="ss6-btn ss6-btn--secondary"
                disabled={confirmBusy}
                onClick={onCancel}
              >
                Not now
              </button>
              <button
                type="button"
                className="ss6-btn ss6-btn--primary"
                disabled={confirmBusy}
                onClick={onConfirmPublish}
              >
                Publish anyway
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="ss6-btn ss6-btn--primary ss6-compat__confirm-btn"
              disabled={confirmBusy}
              onClick={onConfirmPublish}
            >
              Publish desktop-only app
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
