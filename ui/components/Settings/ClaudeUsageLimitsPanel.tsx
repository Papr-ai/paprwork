import React, { useCallback, useEffect, useState } from "react";
import type { ClaudeUsageLimitsSnapshot } from "../../../src/core/services/claudeOAuthUsage";
import { formatClaudeUsageReset } from "../../utils/claudeUsageFormat";
import "./ClaudeUsageLimitsPanel.css";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: ClaudeUsageLimitsSnapshot }
  | { kind: "error"; message: string };

export function ClaudeUsageLimitsPanel() {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result =
        await window.electronAPI?.oauth?.claude?.getUsageLimits?.();
      if (!result) {
        setState({ kind: "error", message: "Usage API unavailable in this build" });
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
        message: err instanceof Error ? err.message : "Could not load plan usage",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sessionRows = state.kind === "ready"
    ? state.data.rows.filter(
        (r) => r.label === "Current session" || r.id.startsWith("session"),
      )
    : [];
  const weeklyRows = state.kind === "ready"
    ? state.data.rows.filter((r) => !sessionRows.includes(r))
    : [];

  return (
    <div className="claude-usage-panel">
      <div className="claude-usage-panel__header">
        <span className="claude-usage-panel__title">Plan usage limits</span>
        <button
          type="button"
          className="claude-usage-panel__refresh"
          onClick={() => void load()}
          disabled={state.kind === "loading"}
          aria-label="Refresh usage"
        >
          {state.kind === "loading" ? "…" : "↻"}
        </button>
      </div>

      {state.kind === "loading" && (
        <p className="claude-usage-panel__muted">Loading usage…</p>
      )}

      {state.kind === "error" && (
        <div className="claude-usage-panel__error">
          <p>{state.message}</p>
          <p className="claude-usage-panel__muted">
            Same data as Claude Code&apos;s <code>/usage</code> and{" "}
            <a
              href="https://claude.ai/new#settings/usage"
              target="_blank"
              rel="noopener noreferrer"
            >
              claude.ai → Usage
            </a>
            . Paprwork tries your Claude Code login (Keychain) first, then your
            pasted Paprwork token. If both fail, run{" "}
            <code>claude auth login</code> in Terminal and refresh.
          </p>
          <button
            type="button"
            className="settings-btn settings-btn--secondary claude-usage-panel__retry"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}

      {state.kind === "ready" && sessionRows.length > 0 && (
        <section className="claude-usage-panel__section">
          <h4 className="claude-usage-panel__section-title">Current session</h4>
          {sessionRows.map((row) => (
            <UsageRow key={row.id} row={row} />
          ))}
        </section>
      )}

      {state.kind === "ready" && weeklyRows.length > 0 && (
        <section className="claude-usage-panel__section">
          <h4 className="claude-usage-panel__section-title">Weekly limits</h4>
          {weeklyRows.map((row) => (
            <UsageRow key={row.id} row={row} />
          ))}
        </section>
      )}

      {state.kind === "ready" && state.data.rows.length === 0 && (
        <p className="claude-usage-panel__muted">No limit rows returned.</p>
      )}

      {state.kind === "ready" && (
        <p className="claude-usage-panel__footnote">
          {state.data.subscriptionType
            ? `${state.data.subscriptionType.replace(/_/g, " ")}`
            : null}
          {state.data.orgName ? ` · ${state.data.orgName}` : null}
          {state.data.credentialSource === "claude_code_keychain"
            ? " · via Claude Code login"
            : state.data.credentialSource === "papr_stored"
              ? " · via Paprwork token"
              : null}
        </p>
      )}
    </div>
  );
}

function UsageRow({
  row,
}: {
  row: ClaudeUsageLimitsSnapshot["rows"][number];
}) {
  const resetLabel = formatClaudeUsageReset(row.resetsAt);
  const severityClass =
    row.percent >= 90
      ? "claude-usage-bar__fill--critical"
      : row.percent >= 70
        ? "claude-usage-bar__fill--warning"
        : "";

  return (
    <div className="claude-usage-row">
      <div className="claude-usage-row__meta">
        <span className="claude-usage-row__label">{row.label}</span>
        <span className="claude-usage-row__pct" title="Percent of this limit used">
          {row.percent}% used
        </span>
      </div>
      <div
        className="claude-usage-bar"
        role="progressbar"
        aria-valuenow={row.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${row.label} ${row.percent}% used`}
      >
        <div
          className={`claude-usage-bar__fill ${severityClass}`}
          style={{ width: `${Math.min(100, row.percent)}%` }}
        />
      </div>
      {resetLabel ? (
        <span className="claude-usage-row__reset">{resetLabel}</span>
      ) : null}
    </div>
  );
}
