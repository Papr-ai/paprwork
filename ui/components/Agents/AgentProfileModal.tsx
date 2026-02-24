import React, { useState, useEffect } from "react";
import { gateway } from "../../src/lib/gateway";
import "./AgentProfileModal.css";

interface SubAgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: string;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
}

interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

interface DelegationRun {
  id: string;
  agentId: string;
  agentName?: string;
  task: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

interface Props {
  agentId: string;
  onClose: () => void;
}

export function AgentProfileModal({ agentId, onClose }: Props) {
  const [agent, setAgent] = useState<SubAgentProfile | null>(null);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [runs, setRuns] = useState<DelegationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "overview" | "config" | "prompt" | "activity"
  >("overview");

  useEffect(() => {
    loadAgentData();
  }, [agentId]);

  const loadAgentData = async () => {
    setLoading(true);
    try {
      const [agentResp, statsResp, runsResp] = await Promise.all([
        gateway.send("subagent:get", { agentId }),
        gateway.send("agent:get-agent-stats", { agentId }),
        gateway.send("subagent:list-runs", {}),
      ]);

      if (agentResp.success && agentResp.data) {
        setAgent(agentResp.data);
        setEditedPrompt(agentResp.data.systemPrompt);
      }
      if (statsResp.success && statsResp.data) {
        setStats(statsResp.data);
      }
      if (runsResp.success && runsResp.data) {
        const agentRuns = runsResp.data.filter(
          (run: DelegationRun) => run.agentId === agentId,
        );
        setRuns(agentRuns.slice(0, 10));
      }
    } catch (error) {
      console.error("[AgentProfile] Failed to load:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSavePrompt = async () => {
    if (!agent) return;
    setSaving(true);
    try {
      const response = await gateway.send("subagent:update", {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        systemPrompt: editedPrompt,
        provider: agent.provider,
        model: agent.model,
        allowedToolIds: agent.allowedToolIds,
        assignedSkills: agent.assignedSkills,
        outputMode: agent.outputMode,
        outputSchema: agent.outputSchema,
        maxTurns: agent.maxTurns,
        memoryPolicy: agent.memoryPolicy,
        icon: agent.icon,
      });

      if (response.success) {
        setAgent({ ...agent, systemPrompt: editedPrompt });
        setEditMode(false);
      }
    } catch (error) {
      console.error("[AgentProfile] Failed to save:", error);
    } finally {
      setSaving(false);
    }
  };

  const successRate =
    runs.length > 0
      ? Math.round(
          (runs.filter((r) => r.status === "completed").length / runs.length) *
            100,
        )
      : 0;

  if (loading || !agent) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="agent-profile-modal loading" onClick={(e) => e.stopPropagation()}>
          <div className="loading-spinner">Loading agent profile...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="agent-profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="profile-header">
          <div className="profile-title-section">
            <div className="agent-avatar-large">
              {getIconSvg(agent.icon ?? "robot")}
            </div>
            <div className="profile-title-info">
              <h2>{agent.name}</h2>
              <p className="agent-description">{agent.description}</p>
            </div>
          </div>
          <button className="close-button" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="profile-tabs">
          <button
            className={`tab ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => setActiveTab("overview")}
          >
            Overview
          </button>
          <button
            className={`tab ${activeTab === "config" ? "active" : ""}`}
            onClick={() => setActiveTab("config")}
          >
            Configuration
          </button>
          <button
            className={`tab ${activeTab === "prompt" ? "active" : ""}`}
            onClick={() => setActiveTab("prompt")}
          >
            System Prompt
          </button>
          <button
            className={`tab ${activeTab === "activity" ? "active" : ""}`}
            onClick={() => setActiveTab("activity")}
          >
            Recent Activity
          </button>
        </div>

        {/* Content */}
        <div className="profile-content">
          {/* Overview Tab */}
          {activeTab === "overview" && (
            <div className="tab-content">
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 3v18h18"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M7 13l4-4 3 3 4-4"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="stat-info">
                    <div className="stat-value">{agent.runCount}</div>
                    <div className="stat-label">Total Runs</div>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon success">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M9 11l3 3L22 4"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="stat-info">
                    <div className="stat-value">{successRate}%</div>
                    <div className="stat-label">Success Rate</div>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <circle
                        cx="12"
                        cy="12"
                        r="3"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M12 1v6m0 6v6M1 12h6m6 0h6"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="stat-info">
                    <div className="stat-value">
                      {stats?.totalTokens
                        ? stats.totalTokens > 1000
                          ? `${(stats.totalTokens / 1000).toFixed(1)}K`
                          : stats.totalTokens
                        : "0"}
                    </div>
                    <div className="stat-label">Tokens Used</div>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon cost">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="stat-info">
                    <div className="stat-value">
                      $
                      {stats?.totalCost
                        ? stats.totalCost.toFixed(4)
                        : "0.0000"}
                    </div>
                    <div className="stat-label">Total Cost</div>
                  </div>
                </div>
              </div>

              <div className="info-section">
                <h3>Model & Provider</h3>
                <div className="info-row">
                  <span className="info-label">Provider:</span>
                  <span className="info-value">
                    {agent.provider ?? "openai"}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Model:</span>
                  <span className="info-value">{agent.model ?? "gpt-5.2"}</span>
                </div>
              </div>

              <div className="info-section">
                <h3>Most Used Tools</h3>
                {stats?.mostUsedTools && stats.mostUsedTools.length > 0 ? (
                  <div className="tools-list">
                    {stats.mostUsedTools.slice(0, 5).map((tool, idx) => (
                      <div key={idx} className="tool-item">
                        <span className="tool-name">{tool.tool}</span>
                        <span className="tool-count">{tool.count} calls</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">No tool usage data yet</p>
                )}
              </div>

              <div className="info-section">
                <h3>Metadata</h3>
                <div className="info-row">
                  <span className="info-label">Created:</span>
                  <span className="info-value">
                    {new Date(agent.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Last Updated:</span>
                  <span className="info-value">
                    {new Date(agent.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Last Run:</span>
                  <span className="info-value">
                    {agent.lastRunAt
                      ? new Date(agent.lastRunAt).toLocaleString()
                      : "Never"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Configuration Tab */}
          {activeTab === "config" && (
            <div className="tab-content">
              <div className="info-section">
                <h3>Behavior Settings</h3>
                <div className="info-row">
                  <span className="info-label">Max Turns:</span>
                  <span className="info-value">{agent.maxTurns ?? 12}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Memory Policy:</span>
                  <span className="info-value">
                    {agent.memoryPolicy ?? "summary"}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Output Mode:</span>
                  <span className="info-value">
                    {agent.outputMode ?? "natural"}
                  </span>
                </div>
              </div>

              <div className="info-section">
                <h3>Allowed Tools ({agent.allowedToolIds?.length ?? 0})</h3>
                {agent.allowedToolIds && agent.allowedToolIds.length > 0 ? (
                  <div className="tags-list">
                    {agent.allowedToolIds.map((toolId) => (
                      <span key={toolId} className="tag tool-tag">
                        {toolId}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">All tools allowed</p>
                )}
              </div>

              <div className="info-section">
                <h3>Assigned Skills ({agent.assignedSkills?.length ?? 0})</h3>
                {agent.assignedSkills && agent.assignedSkills.length > 0 ? (
                  <div className="tags-list">
                    {agent.assignedSkills.map((skill) => (
                      <span key={skill} className="tag skill-tag">
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">No skills assigned</p>
                )}
              </div>

              {agent.outputSchema && (
                <div className="info-section">
                  <h3>Output Schema</h3>
                  <pre className="code-block">
                    {JSON.stringify(agent.outputSchema, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* System Prompt Tab */}
          {activeTab === "prompt" && (
            <div className="tab-content">
              <div className="prompt-section">
                <div className="prompt-header">
                  <h3>System Prompt</h3>
                  {!editMode ? (
                    <button
                      className="edit-button"
                      onClick={() => setEditMode(true)}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <path
                          d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                      </svg>
                      Edit
                    </button>
                  ) : (
                    <div className="edit-actions">
                      <button
                        className="cancel-button"
                        onClick={() => {
                          setEditMode(false);
                          setEditedPrompt(agent.systemPrompt);
                        }}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        className="save-button"
                        onClick={handleSavePrompt}
                        disabled={saving}
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                    </div>
                  )}
                </div>
                {editMode ? (
                  <textarea
                    className="prompt-editor"
                    value={editedPrompt}
                    onChange={(e) => setEditedPrompt(e.target.value)}
                    rows={12}
                  />
                ) : (
                  <pre className="prompt-display">{agent.systemPrompt}</pre>
                )}
              </div>
            </div>
          )}

          {/* Activity Tab */}
          {activeTab === "activity" && (
            <div className="tab-content">
              <div className="info-section">
                <h3>Recent Runs ({runs.length})</h3>
                {runs.length > 0 ? (
                  <div className="runs-list">
                    {runs.map((run) => (
                      <div key={run.id} className="run-item">
                        <div className="run-header">
                          <span
                            className={`run-status status-${run.status}`}
                          />
                          <span className="run-task">{run.task}</span>
                        </div>
                        <div className="run-meta">
                          <span className="run-date">
                            {new Date(run.createdAt).toLocaleString()}
                          </span>
                          {run.completedAt && (
                            <span className="run-duration">
                              Duration:{" "}
                              {Math.round(
                                (new Date(run.completedAt).getTime() -
                                  new Date(run.createdAt).getTime()) /
                                  1000,
                              )}
                              s
                            </span>
                          )}
                        </div>
                        {run.error && (
                          <div className="run-error">{run.error}</div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">No recent activity</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getIconSvg(icon: string) {
  switch (icon) {
    case "search":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
          <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "code":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M16 18l6-6-6-6M8 6l-6 6 6 6"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      );
    case "pen":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      );
    case "chart":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" />
          <path d="M7 13l4-4 3 3 4-4" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    default:
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect
            x="6"
            y="6"
            width="7"
            height="9"
            rx="2"
            stroke="currentColor"
            strokeWidth="2"
          />
          <rect
            x="11"
            y="17"
            width="2"
            height="4"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="9.5" cy="9.5" r="0.5" fill="currentColor" />
          <circle cx="9.5" cy="11.5" r="0.5" fill="currentColor" />
        </svg>
      );
  }
}
