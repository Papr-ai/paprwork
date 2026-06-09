import React from "react";

export type SavingsFormat = "cost" | "tokens";

interface Props {
  actual: number;
  hypothetical: number;
  saved: number;
  format: SavingsFormat;
  compact?: boolean;
}

function formatCost(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatValue(value: number, format: SavingsFormat): string {
  return format === "cost" ? formatCost(value) : formatTokens(value);
}

export function SavingsCompare({
  actual,
  hypothetical,
  saved,
  format,
  compact = false,
}: Props) {
  if (saved <= 0 && actual <= 0) return null;

  return (
    <div className={`savings-compare ${compact ? "savings-compare--compact" : ""}`}>
      <div className="savings-row">
        <span className="savings-label">You used</span>
        <span className="savings-value actual">{formatValue(actual, format)}</span>
      </div>
      <div className="savings-row">
        <span className="savings-label">Without Paprwork</span>
        <span className="savings-value hypothetical">
          {formatValue(hypothetical, format)}
        </span>
      </div>
      <div className="savings-row savings-row--saved">
        <span className="savings-label">You saved</span>
        <span className="savings-value saved">{formatValue(saved, format)}</span>
      </div>

      <style>{`
        .savings-compare {
          padding: 8px 10px;
          border-radius: 8px;
          background: var(--bg-secondary);
          margin-bottom: 10px;
        }

        .savings-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
        }

        .savings-row + .savings-row {
          border-top: 1px solid var(--border-subtle);
        }

        .savings-row--saved {
          padding-top: 6px;
        }

        .savings-label {
          font-size: 10px;
          color: var(--text-secondary);
        }

        .savings-value {
          font-size: 12px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }

        .savings-compare--compact .savings-value {
          font-size: 11px;
        }

        .savings-value.actual {
          color: var(--text-primary);
        }

        .savings-value.hypothetical {
          color: var(--text-tertiary);
          text-decoration: line-through;
        }

        .savings-value.saved {
          color: #059669;
          font-size: 14px;
        }

        .savings-compare--compact .savings-value.saved {
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}
