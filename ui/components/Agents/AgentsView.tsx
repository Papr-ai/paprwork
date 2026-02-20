import React, { useEffect, useMemo, useState } from "react";
import { useSubAgents, type SubAgentProfile } from "../../hooks/useSubAgents";
import { gateway } from "../../src/lib/gateway";
import { useTabStore } from "../../stores/tabStore";
import "./AgentsView.css";

const modelOptions = [
  // Anthropic — weakest to strongest
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-thinking",
  // OpenAI — weakest to strongest
  "gpt-5-mini",
  "gpt-5-2-low",
  "gpt-5-2",
  "gpt-5-2-high",
  "gpt-5-2-xhigh",
  "gpt-5-2-codex",
  // Google — weakest to strongest
  "gemini-2-5-flash-lite",
  "gemini-2-5-flash",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
];

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
  const [agentModel, setAgentModel] = useState("gpt-5-mini");
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

  const { createTab, switchToTab } = useTabStore();

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
      agents: agents.map((a) => ({ id: a.id, name: a.name, runCount: a.runCount })),
      recentRuns: runs.slice(0, 5).map((r) => ({ id: r.id, status: r.status, agentId: r.agentId })),
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
    setAgentModel("gpt-5-mini");
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
        <div style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)" }}>
          Loading agents data...
        </div>
      )}

      {error && (
        <div style={{ 
          padding: "20px", 
          background: "rgba(239, 68, 68, 0.1)", 
          border: "1px solid rgba(239, 68, 68, 0.3)",
          borderRadius: "8px",
          color: "var(--error-color)",
          marginBottom: "20px"
        }}>
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
                  value={agent.model ?? "gpt-5-mini"}
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
