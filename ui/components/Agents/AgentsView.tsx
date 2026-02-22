import React, { useEffect, useMemo, useState } from "react";
import { useSubAgents, type SubAgentProfile } from "../../hooks/useSubAgents";
import { gateway } from "../../src/lib/gateway";
import { useTabStore } from "../../stores/tabStore";
import { CHAT_MODELS } from "../../constants/models";
import { CostTrends } from "./CostTrends";
import "./AgentsView.css";

// Use CHAT_MODELS as single source of truth (excludes openai-codex for agents)
const modelOptions = CHAT_MODELS.filter(
  (m) => m.provider !== "openai-codex",
).map((m) => m.id);

export function AgentsView() {
  const {
    agents,
    runs,
    loading,
    error,
    dashboard,
    loadDashboard,
    loadRuns,
    upsertAgent,
    deleteAgent,
  } = useSubAgents();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentSkills, setAgentSkills] = useState("");
  const [agentModel, setAgentModel] = useState("gpt-5.2");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [selectedTools, setSelectedTools] = useState<Record<string, boolean>>({
    bash: true,
    browser: false,
    papr: true,
    app: true,
    document: true,
    skill: true,
  });
  const [recentChats, setRecentChats] = useState<
    Array<{ id: string; title: string; updatedAt: string }>
  >([]);

  // Cost tracking state
  const [costStats, setCostStats] = useState<{
    today: number;
    thisWeek: number;
    thisMonth: number;
    total: number;
    totalMessages: number;
    topModels: Array<{ model: string; cost: number; count: number }>;
  } | null>(null);

  const { createTab, switchToTab } = useTabStore();

  // Load cost stats on mount
  useEffect(() => {
    const loadCostStats = async () => {
      try {
        const response = await gateway.send("agent:get-cost-stats");
        if (response.success && response.data) {
          setCostStats(response.data);
        }
      } catch (error) {
        console.error("[AgentsView] Failed to load cost stats:", error);
      }
    };
    void loadCostStats();
  }, []);

  useEffect(() => {
    const loadChats = async () => {
      try {
        const response = await gateway.send("chat:list");
        const chats =
          (response.data as Array<{
            id: string;
            title: string;
            updatedAt: string;
          }>) ?? [];
        setRecentChats(
          [...chats]
            .sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() -
                new Date(a.updatedAt).getTime(),
            )
            .slice(0, 10),
        );
      } catch {
        setRecentChats([]);
      }
    };
    void loadChats();
  }, []);

  // Debug logging for data
  useEffect(() => {
    console.log("[AgentsView] Debug Info:", {
      loading,
      error,
      agentsCount: agents.length,
      runsCount: runs.length,
      hasDashboard: !!dashboard,
      dashboard,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        runCount: a.runCount,
      })),
      recentRuns: runs
        .slice(0, 5)
        .map((r) => ({ id: r.id, status: r.status, agentId: r.agentId })),
    });
  }, [agents, runs, dashboard, loading, error]);

  const totalAgents = (dashboard?.totalAgents ?? agents.length) + 1;
  const totalRuns = dashboard?.totalRuns ?? runs.length;
  const successRate = Math.round((dashboard?.successRate ?? 0) * 100);
  const runningRuns =
    dashboard?.runningRuns ??
    runs.filter((run) => run.status === "running").length;
  const uniqueSkillCount = useMemo(() => {
    const set = new Set<string>();
    for (const agent of agents) {
      for (const skill of agent.assignedSkills ?? []) set.add(skill);
    }
    return set.size;
  }, [agents]);

  const sortedRuns = useMemo(
    () =>
      [...runs]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 10),
    [runs],
  );

  const openSkills = () => {
    const tabId = createTab("skills", "skills", "Skills");
    switchToTab(tabId);
  };

  const openJobs = () => {
    const tabId = createTab("jobs", "jobs", "Jobs");
    switchToTab(tabId);
  };

  const getAgentIcon = (agentNameValue: string): string => {
    const name = agentNameValue.toLowerCase();
    if (name.includes("code") || name.includes("review")) return "🔍";
    if (name.includes("content") || name.includes("writ")) return "✍️";
    if (name.includes("ui") || name.includes("design")) return "🎨";
    if (name.includes("scrape") || name.includes("web")) return "🕷️";
    if (name.includes("data") || name.includes("analys")) return "📊";
    return "🤖";
  };

  const buildPrompt = (
    name: string,
    description: string,
    tools: string[],
    skills: string[],
  ): string => {
    const toolDescriptions: Record<string, string> = {
      bash: "bash and local filesystem operations",
      browser: "browser testing and web exploration",
      papr: "PAPR memory retrieval and writeback",
      app: "mini-app creation and updates",
      document: "document creation and edits",
      skill: "installed skill execution",
    };
    const toolsSection = tools
      .map((tool) => `- ${toolDescriptions[tool] ?? tool}`)
      .join("\n");
    const skillsSection =
      skills.length > 0
        ? `\n\nSkills:\n${skills.map((skill) => `- ${skill}`).join("\n")}`
        : "";
    return `You are ${name}, a specialist agent.\n\nPurpose:\n${description}\n\nAvailable tools:\n${toolsSection}${skillsSection}`;
  };

  const createSpecialist = async () => {
    const name = agentName.trim();
    const description = agentDescription.trim();
    if (!name || !description) return;
    const tools = Object.entries(selectedTools)
      .filter(([, enabled]) => enabled)
      .map(([tool]) => tool);
    if (tools.length === 0) return;
    const skills = agentSkills
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    await upsertAgent({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      description,
      systemPrompt:
        agentPrompt || buildPrompt(name, description, tools, skills),
      provider: "openai",
      model: agentModel,
      allowedToolIds: tools,
      assignedSkills: skills,
      outputMode: "natural",
      memoryPolicy: "summary",
      maxTurns: 12,
    });
    setShowCreateModal(false);
    setAgentName("");
    setAgentDescription("");
    setAgentSkills("");
    setAgentModel("gpt-5.2");
    setAgentPrompt("");
  };

  const updateAgentModel = async (agent: SubAgentProfile, model: string) => {
    await upsertAgent({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      provider: agent.provider,
      model,
      allowedToolIds: agent.allowedToolIds ?? [],
      assignedSkills: agent.assignedSkills ?? [],
      outputMode: agent.outputMode,
      outputSchema: agent.outputSchema,
      maxTurns: agent.maxTurns,
      memoryPolicy: agent.memoryPolicy,
    });
    await loadDashboard();
    await loadRuns();
  };

  return (
    <div className="agents-page-native">
      <div className="agents-header-native">
        <div>
          <h1>Agents</h1>
          <p className="page-subtitle">Your AI workforce and their activity</p>
        </div>
        <button
          className="btn-refresh-agents"
          onClick={() => void Promise.all([loadRuns(), loadDashboard()])}
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div
          style={{
            padding: "40px",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          Loading agents data...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "20px",
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            borderRadius: "8px",
            color: "var(--error-color)",
            marginBottom: "20px",
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="agents-overview-native">
        <div className="stat-card-native">
          <div className="stat-content-native">
            <div className="stat-value-native">{totalAgents}</div>
            <div className="stat-label-native">Active Agents</div>
          </div>
        </div>
        <div className="stat-card-native">
          <div className="stat-content-native">
            <div className="stat-value-native">{totalRuns}</div>
            <div className="stat-label-native">Total Delegations</div>
          </div>
        </div>
        <div className="stat-card-native">
          <div className="stat-content-native">
            <div className="stat-value-native">{successRate}%</div>
            <div className="stat-label-native">Success Rate</div>
          </div>
        </div>
        <div className="stat-card-native">
          <div className="stat-content-native">
            <div className="stat-value-native">{runningRuns}</div>
            <div className="stat-label-native">Running Now</div>
          </div>
        </div>
        <div className="stat-card-native">
          <div className="stat-content-native">
            <div className="stat-value-native">{uniqueSkillCount}</div>
            <div className="stat-label-native">Skills Used</div>
          </div>
        </div>
      </div>

      {/* Cost Dashboard */}
      {costStats && (
        <div className="agents-section-native">
          <h2 className="section-title-native">💰 Cost Analytics</h2>
          <div className="cost-stats-grid">
            <div className="cost-card-native">
              <div className="cost-content-native">
                <div className="cost-label-native">Today</div>
                <div className="cost-value-native">
                  ${costStats.today.toFixed(3)}
                </div>
              </div>
            </div>
            <div className="cost-card-native">
              <div className="cost-content-native">
                <div className="cost-label-native">This Week</div>
                <div className="cost-value-native">
                  ${costStats.thisWeek.toFixed(2)}
                </div>
              </div>
            </div>
            <div className="cost-card-native">
              <div className="cost-content-native">
                <div className="cost-label-native">This Month</div>
                <div className="cost-value-native">
                  ${costStats.thisMonth.toFixed(2)}
                </div>
              </div>
            </div>
            <div className="cost-card-native">
              <div className="cost-content-native">
                <div className="cost-label-native">Total Spend</div>
                <div className="cost-value-native">
                  ${costStats.total.toFixed(2)}
                </div>
                <div className="cost-sublabel-native">
                  {costStats.totalMessages.toLocaleString()} messages
                </div>
              </div>
            </div>
          </div>

          {/* Top Models by Cost */}
          {(costStats.topModels ?? []).length > 0 && (
            <div className="top-models-section">
              <h3 className="subsection-title-native">Top Models by Cost</h3>
              <div className="top-models-list">
                {(costStats.topModels ?? [])
                  .slice(0, 5)
                  .map((modelStat, idx) => {
                    const percentage =
                      costStats.total > 0
                        ? ((modelStat.cost / costStats.total) * 100).toFixed(1)
                        : "0";
                    const avgCostPerMessage =
                      modelStat.count > 0
                        ? (modelStat.cost / modelStat.count).toFixed(4)
                        : "0";

                    return (
                      <div key={modelStat.model} className="model-cost-item">
                        <div className="model-rank">{idx + 1}</div>
                        <div className="model-info-cost">
                          <div className="model-name-cost">
                            {modelStat.model}
                          </div>
                          <div className="model-stats-cost">
                            {modelStat.count} messages · ${avgCostPerMessage}
                            /msg
                          </div>
                        </div>
                        <div className="model-cost-details">
                          <div className="model-cost-value">
                            ${modelStat.cost.toFixed(2)}
                          </div>
                          <div className="model-cost-percentage">
                            {percentage}%
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Cost Optimization Tips */}
          {costStats.total > 0 && (
            <div className="cost-tips-section">
              <h3 className="subsection-title-native">💡 Optimization Tips</h3>
              <div className="cost-tips-list">
                {(costStats.topModels ?? []).some(
                  (m) =>
                    m.model?.includes("opus") || m.model?.includes("xhigh"),
                ) && (
                  <div className="cost-tip">
                    <span className="tip-icon">⚡</span>
                    <div className="tip-content">
                      <div className="tip-title">
                        Consider using faster models
                      </div>
                      <div className="tip-description">
                        You're using premium models. Try `gpt-5.2-low` or
                        `claude-haiku-4-5` for routine tasks to save up to 95%.
                      </div>
                    </div>
                  </div>
                )}
                {costStats.thisMonth > 10 && (
                  <div className="cost-tip">
                    <span className="tip-icon">📊</span>
                    <div className="tip-content">
                      <div className="tip-title">Track your spending</div>
                      <div className="tip-description">
                        You're spending ${costStats.thisMonth.toFixed(2)}/month.
                        {costStats.thisMonth > 50 &&
                          " Consider setting up budget alerts."}
                      </div>
                    </div>
                  </div>
                )}
                <div className="cost-tip">
                  <span className="tip-icon">🎯</span>
                  <div className="tip-content">
                    <div className="tip-title">Right tool for the job</div>
                    <div className="tip-description">
                      Use cheaper models for quick tasks, save premium models
                      for complex reasoning.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Cost Trends & Visualizations */}
      <CostTrends />

      <div className="agents-section-native">
        <h2 className="section-title-native">Pen</h2>
        <div className="agent-card-large-native">
          <div className="agent-card-header-native">
            <div className="agent-avatar-native main">✒️</div>
            <div className="agent-info-native">
              <h3>Pen</h3>
              <p>Your primary AI assistant</p>
            </div>
            <div className="agent-status-badge-native active">
              <div className="status-dot-native" />
              Active
            </div>
          </div>
          <div className="agent-metrics-grid-native">
            <div className="metric-item-native">
              <div className="metric-label-native">Delegation Runs</div>
              <div className="metric-value-native">{totalRuns}</div>
              <div className="metric-subtitle-native">
                Across all specialists
              </div>
            </div>
            <div className="metric-item-native">
              <div className="metric-label-native">Completed</div>
              <div className="metric-value-native">
                {dashboard?.completedRuns ?? 0}
              </div>
              <div className="metric-subtitle-native">Successful outcomes</div>
            </div>
            <div className="metric-item-native">
              <div className="metric-label-native">Failed</div>
              <div className="metric-value-native">
                {dashboard?.failedRuns ?? 0}
              </div>
              <div className="metric-subtitle-native">Needs follow-up</div>
            </div>
            <div className="metric-item-native">
              <div className="metric-label-native">Specialists</div>
              <div className="metric-value-native">{agents.length}</div>
              <div className="metric-subtitle-native">
                Available for delegation
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="agents-section-native">
        <div className="section-header-native">
          <h2 className="section-title-native">Specialist Agents</h2>
          <span className="section-count-native">{agents.length}</span>
        </div>
        <div className="agents-grid-native">
          {agents.map((agent) => (
            <div className="specialist-card-native" key={agent.id}>
              <div className="specialist-header-native">
                <div className="specialist-avatar-native">
                  {getAgentIcon(agent.name)}
                </div>
                <div className="specialist-info-native">
                  <h4>{agent.name}</h4>
                  <p>{agent.description}</p>
                </div>
              </div>
              <div className="specialist-stats-native">
                <div className="specialist-stat-native">
                  <div className="stat-label-small">Used</div>
                  <div className="stat-value-small">{agent.runCount} times</div>
                </div>
                <div className="specialist-stat-native">
                  <div className="stat-label-small">Last Active</div>
                  <div className="stat-value-small">
                    {agent.lastRunAt
                      ? new Date(agent.lastRunAt).toLocaleDateString()
                      : "Never"}
                  </div>
                </div>
              </div>
              <div className="specialist-model-native">
                <div className="model-label-small">Model:</div>
                <select
                  className="model-select-specialist"
                  value={agent.model ?? "gpt-5.2"}
                  onChange={(event) =>
                    void updateAgentModel(agent, event.target.value)
                  }
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
              {(agent.allowedToolIds ?? []).length > 0 && (
                <div className="specialist-tools-native">
                  <div className="tools-label-small">Tools:</div>
                  <div className="tools-list-small">
                    {(agent.allowedToolIds ?? []).slice(0, 3).map((tool) => (
                      <span className="tool-badge-small" key={tool}>
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(agent.assignedSkills ?? []).length > 0 && (
                <div className="specialist-skills-native">
                  <div className="skills-label-small">Skills:</div>
                  <div className="skills-list-small">
                    {(agent.assignedSkills ?? []).slice(0, 2).map((skill) => (
                      <span className="skill-badge-small" key={skill}>
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="specialist-actions-native">
                <button
                  className="btn-delete-agent"
                  onClick={() => void deleteAgent(agent.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {agents.length === 0 && !loading && (
            <div className="empty-state-native">
              <h3>No Specialist Agents Yet</h3>
              <p>Specialist agents will appear here when created.</p>
            </div>
          )}
        </div>
      </div>

      <div className="agents-section-native">
        <h2 className="section-title-native">Skills &amp; Tools</h2>
        <div className="marketplace-grid-native">
          <div className="marketplace-card-native">
            <div className="marketplace-content-native">
              <h3>Skills Marketplace</h3>
              <p>Browse and install specialized skills for your agents</p>
              <div className="marketplace-stats-native">
                {uniqueSkillCount} skill(s) in specialist use
              </div>
            </div>
            <button className="btn-marketplace-native" onClick={openSkills}>
              Browse Skills →
            </button>
          </div>
          <div className="marketplace-card-native">
            <div className="marketplace-content-native">
              <h3>Jobs</h3>
              <p>Manage background processes and scheduled automations</p>
              <div className="marketplace-stats-native">
                {runningRuns} running now
              </div>
            </div>
            <button className="btn-marketplace-native" onClick={openJobs}>
              View Jobs →
            </button>
          </div>
          <div className="marketplace-card-native">
            <div className="marketplace-content-native">
              <h3>Create Specialist Agent</h3>
              <p>Build a custom agent for specific tasks</p>
              <div className="marketplace-stats-native">
                Custom tools, skills, and behavior
              </div>
            </div>
            <button
              className="btn-marketplace-native"
              onClick={() => setShowCreateModal(true)}
            >
              Create Agent +
            </button>
          </div>
        </div>
      </div>

      <div className="agents-section-native">
        <h2 className="section-title-native">Recent Activity</h2>
        <div className="activity-timeline-native">
          {sortedRuns.map((run) => (
            <div className="activity-item-native" key={run.id}>
              <div className="activity-marker-native" />
              <div className="activity-content-native">
                <div className="activity-header-native">
                  <div className="activity-title-native">{run.agentId}</div>
                  <div className="activity-time-native">
                    {new Date(run.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="activity-stats-row-native">
                  <span className="activity-stat-native">{run.status}</span>
                  <span className="activity-stat-native">{run.task}</span>
                </div>
                {run.context && (
                  <div className="activity-stat-native">{run.context}</div>
                )}
              </div>
            </div>
          ))}
          {sortedRuns.length === 0 && (
            <div className="empty-state-native">No recent activity yet.</div>
          )}
        </div>
      </div>

      <div className="agents-section-native">
        <h2 className="section-title-native">Recent Conversations</h2>
        <div className="activity-timeline-native">
          {recentChats.map((chat) => (
            <div className="activity-item-native" key={chat.id}>
              <div className="activity-marker-native" />
              <div className="activity-content-native">
                <div className="activity-title-native">
                  {chat.title || "Untitled Chat"}
                </div>
                <div className="activity-time-native">
                  {new Date(chat.updatedAt).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
          {recentChats.length === 0 && (
            <div className="empty-state-native">
              No conversation history yet.
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h2>Create Specialist Agent</h2>
              <button
                className="modal-close"
                onClick={() => setShowCreateModal(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Agent Name</label>
                <input
                  className="form-input"
                  value={agentName}
                  onChange={(event) => setAgentName(event.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  className="form-textarea"
                  rows={3}
                  value={agentDescription}
                  onChange={(event) => setAgentDescription(event.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Available Tools</label>
                <div className="tools-checkboxes">
                  {Object.keys(selectedTools).map((tool) => (
                    <label className="checkbox-label" key={tool}>
                      <input
                        type="checkbox"
                        checked={selectedTools[tool]}
                        onChange={(event) =>
                          setSelectedTools((prev) => ({
                            ...prev,
                            [tool]: event.target.checked,
                          }))
                        }
                      />{" "}
                      {tool}
                    </label>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label>Skills (comma-separated)</label>
                <input
                  className="form-input"
                  value={agentSkills}
                  onChange={(event) => setAgentSkills(event.target.value)}
                />
              </div>
              <div className="form-group">
                <label>AI Model</label>
                <select
                  className="form-input"
                  value={agentModel}
                  onChange={(event) => setAgentModel(event.target.value)}
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Custom System Prompt (optional)</label>
                <textarea
                  className="form-textarea"
                  rows={4}
                  placeholder="Leave empty to use default prompt based on name, description, and tools"
                  value={agentPrompt}
                  onChange={(event) => setAgentPrompt(event.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn-marketplace-native"
                onClick={() => void createSpecialist()}
              >
                Create Agent
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
