import React from "react";

interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  totalToolInvocations?: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

interface Props {
  agentStats: Record<string, AgentStats>;
}

export function ToolsSkillsCard({ agentStats }: Props) {
  // Aggregate all tool calls across all agents
  const toolCounts = new Map<string, number>();

  Object.values(agentStats).forEach((stats) => {
    stats.mostUsedTools.forEach((tool) => {
      const current = toolCounts.get(tool.tool) ?? 0;
      toolCounts.set(tool.tool, current + tool.count);
    });
  });

  // Sort by usage count
  const topTools = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const maxCount = topTools[0]?.count ?? 1;
  const totalToolInvocations = Object.values(agentStats).reduce(
    (sum, stats) =>
      sum +
      (stats.totalToolInvocations ??
        stats.mostUsedTools.reduce((toolSum, tool) => toolSum + tool.count, 0)),
    0,
  );

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          Tools & Skills Usage
        </div>
        <div className="card-badge">
          {totalToolInvocations.toLocaleString()} invocations
        </div>
      </div>

      <div className="card-content">
        {topTools.length === 0 ? (
          <div className="empty-state">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              className="empty-icon"
            >
              <path
                d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            <div className="empty-text">No tool usage data yet</div>
          </div>
        ) : (
          <div className="tools-grid">
            {topTools.map((tool) => {
              const percentage =
                maxCount > 0 ? (tool.count / maxCount) * 100 : 0;
              return (
                <div key={tool.tool} className="tool-card">
                  <div className="tool-header">
                    <div className="tool-icon">{getToolIcon(tool.tool)}</div>
                    <div className="tool-info">
                      <div className="tool-name">
                        {formatToolName(tool.tool)}
                      </div>
                      <div className="tool-count">
                        {tool.count.toLocaleString()} invocations
                      </div>
                    </div>
                  </div>
                  <div className="tool-usage-bar">
                    <div
                      className="tool-usage-fill"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          text-align: center;
        }

        .empty-icon {
          color: var(--text-tertiary);
          opacity: 0.5;
          margin-bottom: 12px;
        }

        .empty-text {
          font-size: 12px;
          color: var(--text-tertiary);
        }

        .tools-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 12px;
        }

        .tool-card {
          padding: 12px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: all 0.2s ease;
        }

        .tool-card:hover {
          background: var(--bg-tertiary);
          border-color: var(--primary-color);
        }

        .tool-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .tool-icon {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--card-bg);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          color: var(--primary-color);
          flex-shrink: 0;
        }

        .tool-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .tool-name {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tool-count {
          font-size: 10px;
          color: var(--text-tertiary);
          font-variant-numeric: tabular-nums;
        }

        .tool-usage-bar {
          height: 4px;
          background: var(--bg-tertiary);
          border-radius: 2px;
          overflow: hidden;
        }

        .tool-usage-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--primary-color), #8b5cf6);
          transition: width 0.3s ease;
        }
      `}</style>
    </div>
  );
}

function formatToolName(tool: string): string {
  // Convert snake_case or kebab-case to Title Case
  if (!tool || typeof tool !== "string") return "";
  return tool
    .split(/[_-]/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

function getToolIcon(tool: string): JSX.Element {
  const iconMap: Record<string, JSX.Element> = {
    bash: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M4 17l6-6-6-6M12 19h8" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
    read: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M13 2v7h7" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
    write: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    ),
    search: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
        <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
    browser: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="2"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M3 9h18" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  };

  // Try to match tool name to icon
  const toolLower = tool.toLowerCase();
  for (const [key, icon] of Object.entries(iconMap)) {
    if (toolLower.includes(key)) {
      return icon;
    }
  }

  // Default icon
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
