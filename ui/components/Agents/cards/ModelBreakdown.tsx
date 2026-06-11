import React from "react";
import { formatModelDisplayName } from "../../../utils/modelDisplayName";

export interface ModelUsageRow {
  model: string;
  cost: number;
  tokens: number;
  count: number;
}

type BreakdownMetric = "cost" | "tokens";

interface Props {
  models: ModelUsageRow[];
  total: number;
  metric: BreakdownMetric;
  limit?: number;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatValue(value: number, metric: BreakdownMetric): string {
  if (metric === "cost") {
    return `$${value.toFixed(2)}`;
  }
  return formatTokens(value);
}

export function ModelBreakdown({
  models,
  total,
  metric,
  limit = 8,
}: Props) {
  if (models.length === 0 || total <= 0) return null;

  const sorted = [...models]
    .filter((row) => (metric === "cost" ? row.cost > 0 : row.tokens > 0))
    .sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens - a.tokens));

  const visible = sorted.slice(0, limit);
  const hiddenCount = Math.max(0, sorted.length - visible.length);

  const barClass =
    metric === "cost" ? "model-bar model-bar--cost" : "model-bar model-bar--tokens";

  return (
    <div className="model-breakdown">
      <div className="model-breakdown-label">By Model</div>
      <div className="model-breakdown-list">
        {visible.map((row) => {
          const value = metric === "cost" ? row.cost : row.tokens;
          const percentage = total > 0 ? (value / total) * 100 : 0;

          return (
            <div key={row.model} className="model-breakdown-item">
              <div className="model-breakdown-info">
                <span className="model-breakdown-name" title={row.model}>
                  {formatModelDisplayName(row.model)}
                </span>
                <span className="model-breakdown-value">
                  {formatValue(value, metric)}
                </span>
              </div>
              <div className="model-breakdown-bar-container">
                <div
                  className={barClass}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 ? (
        <div className="model-breakdown-more">
          +{hiddenCount} more model{hiddenCount === 1 ? "" : "s"} with usage
        </div>
      ) : null}

      <style>{`
        .model-breakdown {
          padding-top: 12px;
          border-top: 1px solid var(--border-color);
        }

        .model-breakdown-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 8px;
        }

        .model-breakdown-more {
          font-size: 10px;
          color: var(--text-tertiary);
          margin-top: 8px;
        }

        .model-breakdown-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .model-breakdown-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .model-breakdown-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .model-breakdown-name {
          font-size: 11px;
          color: var(--text-secondary);
          font-weight: 500;
        }

        .model-breakdown-value {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .model-breakdown-bar-container {
          height: 3px;
          background: var(--bg-secondary);
          border-radius: 2px;
          overflow: hidden;
        }

        .model-bar {
          height: 100%;
          transition: width 0.3s ease;
        }

        .model-bar--cost {
          background: var(--primary-color);
        }

        .model-bar--tokens {
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
        }
      `}</style>
    </div>
  );
}
