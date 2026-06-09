import React, { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { gateway } from "../../src/lib/gateway";
import "./CostTrends.css";

interface DailyTrend {
  date: string;
  cost: number;
  messages: number;
  tokens: number;
}

interface ModelDistribution {
  model: string;
  percentage: number;
  cost: number;
  messages: number;
}

const COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#3b82f6", // blue
  "#ef4444", // red
  "#06b6d4", // cyan
];

export function CostTrends() {
  const [dailyTrends, setDailyTrends] = useState<DailyTrend[]>([]);
  const [modelDistribution, setModelDistribution] = useState<
    ModelDistribution[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<7 | 30 | 90>(30);

  useEffect(() => {
    loadData();
  }, [timeRange]);

  async function loadData() {
    setLoading(true);
    try {
      const [trendsResponse, distributionResponse] = await Promise.all([
        gateway.send("agent:get-cost-trends", { days: timeRange }),
        gateway.send("agent:get-model-distribution"),
      ]);

      if (trendsResponse.success && trendsResponse.data) {
        setDailyTrends(trendsResponse.data);
      }

      if (distributionResponse.success && distributionResponse.data) {
        setModelDistribution(distributionResponse.data);
      }
    } catch (error) {
      console.error("[CostTrends] Failed to load data:", error);
    } finally {
      setLoading(false);
    }
  }

  const formatCost = (value: number) => {
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  if (loading) {
    return (
      <div className="cost-trends-loading">
        <div className="spinner" />
        <p>Loading cost trends...</p>
      </div>
    );
  }

  const hasData = dailyTrends.length > 0 || modelDistribution.length > 0;

  if (!hasData) {
    return (
      <div className="cost-trends-empty">
        <div className="empty-icon">📊</div>
        <h3>No cost data yet</h3>
        <p>Start chatting to see your spending trends and analytics</p>
      </div>
    );
  }

  // Calculate total cost for the period
  const totalCostInPeriod = dailyTrends.reduce((sum, day) => sum + day.cost, 0);
  const totalMessagesInPeriod = dailyTrends.reduce(
    (sum, day) => sum + day.messages,
    0,
  );
  const avgCostPerDay = totalCostInPeriod / timeRange;

  return (
    <div className="cost-trends-section">
      <div className="trends-header">
        <h2 className="section-title-native">📈 Cost Trends & Analytics</h2>
        <div className="time-range-selector">
          <button
            className={`time-btn ${timeRange === 7 ? "active" : ""}`}
            onClick={() => setTimeRange(7)}
          >
            7 Days
          </button>
          <button
            className={`time-btn ${timeRange === 30 ? "active" : ""}`}
            onClick={() => setTimeRange(30)}
          >
            30 Days
          </button>
          <button
            className={`time-btn ${timeRange === 90 ? "active" : ""}`}
            onClick={() => setTimeRange(90)}
          >
            90 Days
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="trend-stats-grid">
        <div className="trend-stat-card">
          <div className="stat-icon">💵</div>
          <div className="stat-info">
            <div className="stat-label">Total Cost ({timeRange} days)</div>
            <div className="stat-value">{formatCost(totalCostInPeriod)}</div>
          </div>
        </div>
        <div className="trend-stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-info">
            <div className="stat-label">Avg Per Day</div>
            <div className="stat-value">{formatCost(avgCostPerDay)}</div>
          </div>
        </div>
        <div className="trend-stat-card">
          <div className="stat-icon">💬</div>
          <div className="stat-info">
            <div className="stat-label">Messages</div>
            <div className="stat-value">
              {totalMessagesInPeriod.toLocaleString()}
            </div>
          </div>
        </div>
        <div className="trend-stat-card">
          <div className="stat-icon">⚡</div>
          <div className="stat-info">
            <div className="stat-label">Avg Per Message</div>
            <div className="stat-value">
              {formatCost(
                totalMessagesInPeriod > 0
                  ? totalCostInPeriod / totalMessagesInPeriod
                  : 0,
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="charts-grid">
        {/* Daily Cost Line Chart */}
        {dailyTrends.length > 0 && (
          <div className="chart-card">
            <h3 className="chart-title">Daily Spending</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dailyTrends}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border-color)"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="var(--text-secondary)"
                  style={{ fontSize: "12px" }}
                />
                <YAxis
                  tickFormatter={formatCost}
                  stroke="var(--text-secondary)"
                  style={{ fontSize: "12px" }}
                />
                <Tooltip
                  formatter={(value: any) => formatCost(value)}
                  labelFormatter={formatDate}
                  contentStyle={{
                    background: "var(--card-bg)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={{ fill: "#6366f1", r: 4 }}
                  activeDot={{ r: 6 }}
                  name="Cost"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Daily Messages Bar Chart */}
        {dailyTrends.length > 0 && (
          <div className="chart-card">
            <h3 className="chart-title">Daily Messages</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={dailyTrends}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border-color)"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="var(--text-secondary)"
                  style={{ fontSize: "12px" }}
                />
                <YAxis
                  stroke="var(--text-secondary)"
                  style={{ fontSize: "12px" }}
                />
                <Tooltip
                  labelFormatter={formatDate}
                  contentStyle={{
                    background: "var(--card-bg)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                  }}
                />
                <Legend />
                <Bar
                  dataKey="messages"
                  fill="#8b5cf6"
                  name="Messages"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Model Distribution Pie Chart */}
        {modelDistribution.length > 0 && (
          <div className="chart-card">
            <h3 className="chart-title">Model Cost Distribution</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={modelDistribution}
                  dataKey="cost"
                  nameKey="model"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={(entry) =>
                    `${entry.model}: ${entry.percentage.toFixed(1)}%`
                  }
                  labelLine={false}
                >
                  {modelDistribution.map((_entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: any) => formatCost(value)}
                  contentStyle={{
                    background: "var(--card-bg)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="model-legend">
              {modelDistribution.map((model, index) => (
                <div key={model.model} className="model-legend-item">
                  <div
                    className="legend-color"
                    style={{ background: COLORS[index % COLORS.length] }}
                  />
                  <div className="legend-text">
                    <span className="legend-model">{model.model}</span>
                    <span className="legend-details">
                      {formatCost(model.cost)} · {model.messages} msgs
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
