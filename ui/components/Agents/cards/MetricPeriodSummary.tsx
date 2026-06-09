import React from "react";

export type PeriodMetricFormat = "cost" | "tokens";

interface PeriodValues {
  today: number;
  thisWeek: number;
  thisMonth: number;
}

interface Props {
  label: string;
  total: number;
  sublabel?: string;
  periods: PeriodValues;
  format: PeriodMetricFormat;
}

function formatCost(value: number): string {
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatValue(value: number, format: PeriodMetricFormat): string {
  return format === "cost" ? formatCost(value) : formatTokens(value);
}

export function MetricPeriodSummary({
  label,
  total,
  sublabel,
  periods,
  format,
}: Props) {
  const periodItems = [
    { key: "today", label: "Today", value: periods.today },
    { key: "week", label: "Week", value: periods.thisWeek },
    { key: "month", label: "Month", value: periods.thisMonth },
  ] as const;

  return (
    <div className="metric-period-summary">
      <div className="metric-period-primary">
        <div className="metric-period-label">{label}</div>
        <div className="metric-period-total">
          {formatValue(total, format)}
        </div>
        {sublabel ? (
          <div className="metric-period-sublabel">{sublabel}</div>
        ) : null}
      </div>
      <div className="metric-period-grid">
        {periodItems.map((item) => (
          <div key={item.key} className="metric-period-cell">
            <span className="metric-period-cell-label">{item.label}</span>
            <span className="metric-period-cell-value">
              {formatValue(item.value, format)}
            </span>
          </div>
        ))}
      </div>

      <style>{`
        .metric-period-summary {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          border-radius: 8px;
          background: var(--bg-secondary);
          margin-bottom: 10px;
        }

        .metric-period-primary {
          min-width: 0;
        }

        .metric-period-label {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.4px;
          margin-bottom: 2px;
        }

        .metric-period-total {
          font-size: 22px;
          font-weight: 700;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
          line-height: 1.1;
        }

        .metric-period-sublabel {
          font-size: 10px;
          color: var(--text-secondary);
          margin-top: 2px;
        }

        .metric-period-grid {
          display: flex;
          gap: 10px;
          flex-shrink: 0;
        }

        .metric-period-cell {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 1px;
          min-width: 52px;
        }

        .metric-period-cell-label {
          font-size: 9px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .metric-period-cell-value {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}
