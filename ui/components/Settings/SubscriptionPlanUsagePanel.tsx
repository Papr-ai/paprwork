import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ClaudeUsageLimitsSnapshot } from "../../../src/core/services/claudeOAuthUsage";
import type { CodexUsageLimitsSnapshot } from "../../../src/core/services/codexOAuthUsage";
import { formatClaudeUsageReset } from "../../utils/claudeUsageFormat";
import {
  getPlanUsageHeroLines,
  planUsageBrand,
  summarizeClaudePlanUsage,
  summarizeCodexPlanUsage,
  type PlanProvider,
} from "../../utils/subscriptionPlanUsage";
import "./SubscriptionPlanUsagePanel.css";

type UsageSnapshot = ClaudeUsageLimitsSnapshot | CodexUsageLimitsSnapshot;

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: UsageSnapshot }
  | { kind: "error"; message: string };

function severityClass(percent: number): string {
  if (percent >= 90) return "plan-usage-bar__fill--critical";
  if (percent >= 70) return "plan-usage-bar__fill--warning";
  return "";
}

function shortMetricLabel(label: string): string {
  if (label.startsWith("Weekly (")) {
    const inner = label.slice("Weekly (".length, -1);
    return inner === "all models" ? "Weekly" : inner;
  }
  if (label.startsWith("Session")) return "Session";
  return label;
}

async function fetchUsageSnapshot(provider: PlanProvider) {
  if (provider === "anthropic") {
    return window.electronAPI?.oauth?.claude?.getUsageLimits?.();
  }
  return window.electronAPI?.oauth?.openai?.getUsageLimits?.();
}

export function SubscriptionPlanUsagePanel({
  provider,
}: {
  provider: PlanProvider;
}) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** Keeps the modal mounted while a refresh is in flight. */
  const [modalSnapshot, setModalSnapshot] = useState<UsageSnapshot | null>(
    null,
  );
  const brand = planUsageBrand(provider);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await fetchUsageSnapshot(provider);
      if (!result) {
        setState({
          kind: "error",
          message: "Usage API unavailable in this build",
        });
        return;
      }
      if (result.success && result.data) {
        setState({ kind: "ready", data: result.data });
        return;
      }
      setState({
        kind: "error",
        message: result.error ?? "Could not load plan usage",
      });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Could not load plan usage",
      });
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind === "ready") {
      setModalSnapshot(state.data);
    }
  }, [state]);

  useEffect(() => {
    if (!detailsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailsOpen]);

  const summary = useMemo(() => {
    if (state.kind !== "ready") return null;
    const data = state.data;
    if (provider === "openai") {
      return summarizeCodexPlanUsage(data as CodexUsageLimitsSnapshot);
    }
    return summarizeClaudePlanUsage(data as ClaudeUsageLimitsSnapshot);
  }, [state, provider]);

  const heroLines = useMemo(() => {
    if (!summary) return [];
    return getPlanUsageHeroLines(summary, {
      includeFableWeekly: provider === "anthropic",
    });
  }, [summary, provider]);

  const headlinePercent = useMemo(() => {
    if (!summary) return null;
    if (summary.activePercent !== null) return summary.activePercent;
    const values = heroLines.map((line) => line.percent);
    return values.length > 0 ? Math.max(...values) : null;
  }, [summary, heroLines]);

  return (
    <>
      <div className="plan-usage-compact">
        <div className="plan-usage-compact__header">
          <span className="plan-usage-compact__title">Plan usage</span>
          <div className="plan-usage-compact__actions">
            <button
              type="button"
              className="plan-usage-compact__refresh"
              onClick={() => void load()}
              disabled={state.kind === "loading"}
              aria-label="Refresh usage"
            >
              {state.kind === "loading" ? "…" : "↻"}
            </button>
          </div>
        </div>

        {state.kind === "loading" && (
          <p className="plan-usage-compact__muted">Loading…</p>
        )}

        {state.kind === "error" && (
          <div className="plan-usage-compact__error">
            <p>{state.message}</p>
            <button
              type="button"
              className="plan-usage-compact__details-btn"
              onClick={() => setDetailsOpen(true)}
            >
              Troubleshooting
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--secondary plan-usage-compact__retry"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        )}

        {state.kind === "ready" && heroLines.length > 0 && (
          <>
            <div className="plan-usage-compact__summary">
              {headlinePercent !== null && (
                <span className="plan-usage-compact__headline">
                  {headlinePercent}% used
                </span>
              )}
              <div className="plan-usage-compact__metrics">
                {heroLines.map((line) => (
                  <div
                    key={line.key}
                    className={
                      line.isActive
                        ? "plan-usage-compact__metric plan-usage-compact__metric--active"
                        : "plan-usage-compact__metric"
                    }
                  >
                    <span className="plan-usage-compact__metric-label">
                      {shortMetricLabel(line.label)}
                    </span>
                    <span className="plan-usage-compact__metric-pct">
                      {line.percent}%
                    </span>
                    <div
                      className="plan-usage-bar plan-usage-bar--compact"
                      role="progressbar"
                      aria-valuenow={line.percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${line.label} ${line.percent}% used`}
                    >
                      <div
                        className={`plan-usage-bar__fill ${severityClass(line.percent)}`}
                        style={{ width: `${Math.min(100, line.percent)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="plan-usage-compact__details-btn"
              onClick={() => setDetailsOpen(true)}
            >
              View details
            </button>
          </>
        )}

        {state.kind === "ready" && heroLines.length === 0 && (
          <p className="plan-usage-compact__muted">No limit rows returned.</p>
        )}
      </div>

      {detailsOpen && (
        <PlanUsageDetailsModal
          brand={brand}
          provider={provider}
          data={modalSnapshot}
          errorMessage={state.kind === "error" ? state.message : null}
          onClose={() => setDetailsOpen(false)}
          onRefresh={() => void load()}
          refreshing={state.kind === "loading"}
        />
      )}
    </>
  );
}

function PlanUsageDetailsModal({
  brand,
  provider,
  data,
  errorMessage,
  onClose,
  onRefresh,
  refreshing,
}: {
  brand: string;
  provider: PlanProvider;
  data: UsageSnapshot | null;
  errorMessage: string | null;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const sessionRows =
    data?.rows.filter(
      (r) => r.label === "Current session" || r.id.startsWith("session"),
    ) ?? [];
  const weeklyRows =
    data?.rows.filter((r) => !sessionRows.includes(r)) ?? [];

  const footnoteParts: string[] = [];
  if (data?.subscriptionType) {
    footnoteParts.push(data.subscriptionType.replace(/_/g, " "));
  }
  if (data && provider === "anthropic") {
    const claude = data as ClaudeUsageLimitsSnapshot;
    if (claude.orgName) footnoteParts.push(claude.orgName);
    if (claude.credentialSource === "claude_code_keychain") {
      footnoteParts.push("via Claude Code login");
    } else if (claude.credentialSource === "papr_stored") {
      footnoteParts.push("via Paprwork token");
    }
  } else if (data && provider === "openai") {
    const codex = data as CodexUsageLimitsSnapshot;
    if (codex.creditBalance) {
      footnoteParts.push(`Credits ${codex.creditBalance}`);
    }
  }

  return (
    <div
      className="token-modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="token-modal plan-usage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-usage-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="token-modal__header">
          <h2 id="plan-usage-modal-title" className="token-modal__title">
            {brand} plan usage
          </h2>
          <button
            type="button"
            className="token-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="token-modal__body plan-usage-modal__body">
          <div className="plan-usage-modal__toolbar">
            <button
              type="button"
              className="settings-btn settings-btn--secondary plan-usage-modal__refresh"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            {data ? (
              <span className="plan-usage-compact__muted">
                Updated{" "}
                {new Date(data.fetchedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            ) : null}
          </div>

          {errorMessage ? (
            <p className="plan-usage-modal__error">{errorMessage}</p>
          ) : null}

          {sessionRows.length > 0 && (
            <section className="plan-usage-modal__section">
              <h3 className="plan-usage-modal__section-title">Current session</h3>
              {sessionRows.map((row) => (
                <UsageDetailRow key={row.id} row={row} />
              ))}
            </section>
          )}

          {weeklyRows.length > 0 && (
            <section className="plan-usage-modal__section">
              <h3 className="plan-usage-modal__section-title">Weekly limits</h3>
              {weeklyRows.map((row) => (
                <UsageDetailRow key={row.id} row={row} />
              ))}
            </section>
          )}

          {footnoteParts.length > 0 && (
            <p className="plan-usage-modal__footnote">
              {footnoteParts.join(" · ")}
            </p>
          )}

          <p className="plan-usage-modal__help plan-usage-compact__muted">
            {provider === "openai" ? (
              <>
                Same data as the ChatGPT usage Codex reports for your account.
                Limits are shared across ChatGPT and Codex.
              </>
            ) : (
              <>
                Same data as Claude Code&apos;s <code>/usage</code> and{" "}
                <a
                  href="https://claude.ai/new#settings/usage"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  claude.ai → Usage
                </a>
                . Paprwork tries your Claude Code login (Keychain) first, then
                your pasted Paprwork token. If both fail, run{" "}
                <code>claude auth login</code> in Terminal and refresh.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function UsageDetailRow({
  row,
}: {
  row: UsageSnapshot["rows"][number];
}) {
  const resetLabel = formatClaudeUsageReset(row.resetsAt);
  return (
    <div className="plan-usage-row">
      <div className="plan-usage-row__meta">
        <span className="plan-usage-row__label">{row.label}</span>
        <span className="plan-usage-row__pct">{row.percent}% used</span>
      </div>
      <div
        className="plan-usage-bar"
        role="progressbar"
        aria-valuenow={row.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${row.label} ${row.percent}% used`}
      >
        <div
          className={`plan-usage-bar__fill ${severityClass(row.percent)}`}
          style={{ width: `${Math.min(100, row.percent)}%` }}
        />
      </div>
      {resetLabel ? (
        <span className="plan-usage-row__reset">{resetLabel}</span>
      ) : null}
    </div>
  );
}

/** @deprecated Use SubscriptionPlanUsagePanel with provider="anthropic" */
export function ClaudeUsageLimitsPanel() {
  return <SubscriptionPlanUsagePanel provider="anthropic" />;
}
