import React from "react";

interface CostStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  total: number;
  totalMessages: number;
  topModels: Array<{ model: string; cost: number; count: number }>;
}

interface Props {
  costStats: CostStats | null;
}

export function CostOverviewCard({ costStats }: Props) {
  if (!costStats) {
    return (
      <div className="metric-card">
        <div className="card-header">
          <div className="card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            Cost Overview
          </div>
        </div>
        <div className="card-content">
          <div className="loading-message">Loading cost data...</div>
        </div>
      </div>
    );
  }

  const lastWeekCost = costStats.thisWeek - costStats.today;
  const weekTrend =
    lastWeekCost > 0
      ? ((costStats.today - lastWeekCost) / lastWeekCost) * 100
      : 0;

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          Cost Overview
        </div>
        {weekTrend !== 0 && (
          <div
            className={`trend-badge ${weekTrend > 0 ? "trend-up" : "trend-down"}`}
          >
            {weekTrend > 0 ? "↑" : "↓"} {Math.abs(weekTrend).toFixed(1)}%
          </div>
        )}
      </div>

      <div className="card-content">
        {/* Total Cost - Large Display */}
        <div className="cost-total">
          <div className="cost-label">Total Spend</div>
          <div className="cost-value-large">${costStats.total.toFixed(2)}</div>
          <div className="cost-sublabel">
            {costStats.totalMessages.toLocaleString()} messages
          </div>
        </div>

        {/* Time Breakdown */}
        <div className="cost-breakdown">
          <div className="cost-breakdown-item">
            <div className="breakdown-label">Today</div>
            <div className="breakdown-value">${costStats.today.toFixed(3)}</div>
          </div>
          <div className="cost-breakdown-item">
            <div className="breakdown-label">This Week</div>
            <div className="breakdown-value">
              ${costStats.thisWeek.toFixed(2)}
            </div>
          </div>
          <div className="cost-breakdown-item">
            <div className="breakdown-label">This Month</div>
            <div className="breakdown-value">
              ${costStats.thisMonth.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Top Models */}
        {(costStats.topModels ?? []).length > 0 && (
          <div className="cost-models">
            <div className="models-label">By Model</div>
            <div className="models-list">
              {(costStats.topModels ?? []).slice(0, 3).map((model) => {
                const percentage =
                  costStats.total > 0
                    ? (model.cost / costStats.total) * 100
                    : 0;
                return (
                  <div key={model.model} className="model-item">
                    <div className="model-info">
                      <span className="model-name">{model.model}</span>
                      <span className="model-cost">
                        ${model.cost.toFixed(2)}
                      </span>
                    </div>
                    <div className="model-bar-container">
                      <div
                        className="model-bar"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .cost-total {
          text-align: center;
          padding: 16px 0;
        }

        .cost-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .cost-value-large {
          font-size: 36px;
          font-weight: 700;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .cost-sublabel {
          font-size: 11px;
          color: var(--text-secondary);
          margin-top: 4px;
        }

        .cost-breakdown {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          padding: 16px 0;
          border-top: 1px solid var(--border-color);
          border-bottom: 1px solid var(--border-color);
        }

        .cost-breakdown-item {
          text-align: center;
        }

        .breakdown-label {
          font-size: 10px;
          color: var(--text-tertiary);
          margin-bottom: 6px;
          text-transform: uppercase;
        }

        .breakdown-value {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .cost-models {
          padding-top: 12px;
        }

        .models-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        .models-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .model-item {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .model-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .model-name {
          font-size: 11px;
          color: var(--text-secondary);
          font-family: 'SF Mono', Monaco, monospace;
        }

        .model-cost {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .model-bar-container {
          height: 4px;
          background: var(--bg-secondary);
          border-radius: 2px;
          overflow: hidden;
        }

        .model-bar {
          height: 100%;
          background: var(--primary-color);
          transition: width 0.3s ease;
        }

        .trend-badge {
          font-size: 11px;
          font-weight: 600;
          padding: 4px 8px;
          border-radius: 4px;
        }

        .trend-up {
          color: #ef4444;
          background: rgba(239, 68, 68, 0.1);
        }

        .trend-down {
          color: #10b981;
          background: rgba(16, 185, 129, 0.1);
        }

        .loading-message {
          text-align: center;
          padding: 40px 20px;
          color: var(--text-secondary);
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}
