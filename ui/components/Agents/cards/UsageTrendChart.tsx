import React, { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface DailyUsageTrend {
  date: string;
  cost: number;
  messages: number;
  tokens: number;
}

type MetricKey = "cost" | "tokens";
type TimeRange = 7 | 30 | 90;

interface Props {
  trends: DailyUsageTrend[] | null;
  metric: MetricKey;
  loading?: boolean;
  onRangeChange?: (days: TimeRange) => void;
  range?: TimeRange;
}

function formatDate(dateStr: string): string {
  const date = new Date(`${dateStr}T12:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCost(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatMetric(value: number, metric: MetricKey): string {
  return metric === "cost" ? formatCost(value) : formatTokens(value);
}

export function UsageTrendChart({
  trends,
  metric,
  loading = false,
  onRangeChange,
  range = 30,
}: Props) {
  const [localRange, setLocalRange] = useState<TimeRange>(range);
  const activeRange = onRangeChange ? range : localRange;

  const handleRange = (days: TimeRange): void => {
    if (onRangeChange) {
      onRangeChange(days);
    } else {
      setLocalRange(days);
    }
  };

  const dataKey = metric;
  const stroke = metric === "cost" ? "#6366f1" : "#8b5cf6";
  const fillId = `usage-trend-${metric}`;
  const normalizedTrends =
    trends?.map((day) => ({
      ...day,
      cost: Number(day.cost ?? 0),
      tokens: Number(day.tokens ?? 0),
      messages: Number(day.messages ?? 0),
    })) ?? null;

  const periodTotal =
    normalizedTrends?.reduce((sum, day) => sum + day[dataKey], 0) ?? 0;

  return (
    <div className="usage-trend-chart">
      <div className="usage-trend-header">
        <div className="usage-trend-title">
          {metric === "cost" ? "Spend over time" : "Tokens over time"}
        </div>
        <div className="usage-trend-range">
          {([7, 30, 90] as const).map((days) => (
            <button
              key={days}
              type="button"
              className={`usage-trend-range-btn ${activeRange === days ? "active" : ""}`}
              onClick={() => handleRange(days)}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="usage-trend-loading">Loading trend…</div>
      ) : !normalizedTrends || normalizedTrends.length === 0 ? (
        <div className="usage-trend-empty">No usage in this period yet</div>
      ) : (
        <>
          <div className="usage-trend-period-total">
            {formatMetric(periodTotal, metric)} in {activeRange} days
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart
              data={normalizedTrends}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border-color)"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                stroke="var(--text-tertiary)"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(value: number) =>
                  metric === "cost"
                    ? value < 1
                      ? `$${value.toFixed(2)}`
                      : `$${value.toFixed(0)}`
                    : formatTokens(value)
                }
                stroke="var(--text-tertiary)"
                tick={{ fontSize: 10 }}
                width={42}
              />
              <Tooltip
                formatter={(value: number) => formatMetric(value, metric)}
                labelFormatter={formatDate}
                contentStyle={{
                  background: "var(--card-bg)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={stroke}
                strokeWidth={2}
                fill={`url(#${fillId})`}
                name={metric === "cost" ? "Spend" : "Tokens"}
              />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}

      <style>{`
        .usage-trend-chart {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--border-color);
        }

        .usage-trend-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }

        .usage-trend-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }

        .usage-trend-range {
          display: flex;
          gap: 4px;
        }

        .usage-trend-range-btn {
          border: 1px solid var(--border-color);
          background: transparent;
          color: var(--text-tertiary);
          font-size: 10px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
          cursor: pointer;
        }

        .usage-trend-range-btn.active {
          color: var(--primary-color);
          border-color: var(--primary-color);
          background: rgba(99, 102, 241, 0.08);
        }

        .usage-trend-period-total {
          font-size: 11px;
          color: var(--text-tertiary);
          margin-bottom: 4px;
        }

        .usage-trend-loading,
        .usage-trend-empty {
          height: 140px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          color: var(--text-tertiary);
        }
      `}</style>
    </div>
  );
}
