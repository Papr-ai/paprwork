/**
 * ContextInspectorModal - Shows detailed breakdown of what's sent to the LLM
 * 
 * Displays:
 * - Total token count
 * - System prompt
 * - Conversation summary (if present)
 * - Message history
 * - Tool schemas
 * - Workspace files (.md files)
 * - Active skills
 * - Active plans
 */

import React, { useState } from "react";
import "./ContextInspectorModal.css";

interface ContextSection {
  tokens: number;
  content?: string;
  count?: number;
  note?: string;
  [key: string]: unknown;
}

interface ContextBreakdown {
  systemPrompt: ContextSection;
  conversationSummary: ContextSection | null;
  messages: ContextSection & {
    breakdown: Array<{ role: string; tokens: number; preview: string }>;
  };
  tools: ContextSection & {
    schemas: Array<{ id: string; description: string; parameters: unknown }>;
  };
  workspaceFiles: ContextSection & {
    files: Array<{ name: string; content: string; size: number }>;
  };
  skills: ContextSection & {
    skills: Array<{ id: string; name: string; description: string }>;
  };
  plans: ContextSection & {
    plans: Array<{
      planId: string;
      title: string;
      steps: Array<{ id: string; description: string; status: string }>;
    }>;
  };
}

interface ContextInfo {
  model: string;
  totalTokens: number;
  breakdown: ContextBreakdown;
}

interface ContextInspectorModalProps {
  contextInfo: ContextInfo;
  onClose: () => void;
}

export const ContextInspectorModal: React.FC<ContextInspectorModalProps> = ({
  contextInfo,
  onClose,
}) => {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(),
  );

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const formatNumber = (num: number) => num.toLocaleString();

  const renderSection = (
    id: string,
    title: string,
    tokens: number,
    content: React.ReactNode,
    note?: string,
  ) => {
    const isExpanded = expandedSections.has(id);
    const percentage = ((tokens / contextInfo.totalTokens) * 100).toFixed(1);

    return (
      <div className="context-section" key={id}>
        <button
          className="context-section-header"
          onClick={() => toggleSection(id)}
        >
          <span className="context-section-title">
            <span className="context-section-icon">
              {isExpanded ? "▼" : "▶"}
            </span>
            {title}
            {note && <span className="context-note">({note})</span>}
          </span>
          <span className="context-section-stats">
            <span className="context-token-count">
              {formatNumber(tokens)} tokens
            </span>
            <span className="context-percentage">({percentage}%)</span>
          </span>
        </button>
        {isExpanded && (
          <div className="context-section-content">{content}</div>
        )}
      </div>
    );
  };

  const renderSystemPrompt = () => {
    const { systemPrompt } = contextInfo.breakdown;
    return (
      <div className="context-text-content">
        {systemPrompt.note && (
          <div className="context-section-note">
            ℹ️ {systemPrompt.note}
          </div>
        )}
        <pre>{systemPrompt.content}</pre>
      </div>
    );
  };

  const renderConversationSummary = () => {
    const { conversationSummary } = contextInfo.breakdown;
    if (!conversationSummary) return null;

    return renderSection(
      "summary",
      "Conversation Summary",
      conversationSummary.tokens,
      <div className="context-text-content">
        {conversationSummary.note && (
          <div className="context-section-note">
            ℹ️ {conversationSummary.note}
          </div>
        )}
        <pre>{conversationSummary.content}</pre>
      </div>,
      "User message",
    );
  };

  const renderMessages = () => {
    const { messages } = contextInfo.breakdown;
    return (
      <div className="context-messages">
        <div className="context-section-info">
          {messages.count} messages in history
        </div>
        <div className="message-list">
          {messages.breakdown.map((msg, idx) => (
            <div key={idx} className={`message-preview message-${msg.role}`}>
              <div className="message-preview-header">
                <span className="message-role">{msg.role}</span>
                <span className="message-tokens">
                  {formatNumber(msg.tokens)} tokens
                </span>
              </div>
              <div className="message-preview-content">{msg.preview}...</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderTools = () => {
    const { tools } = contextInfo.breakdown;
    return (
      <div className="context-tools">
        <div className="context-section-info">{tools.count} tools available</div>
        <div className="tool-list">
          {tools.schemas.map((tool) => (
            <div key={tool.id} className="tool-item">
              <div className="tool-header">
                <span className="tool-id">{tool.id}</span>
              </div>
              <div className="tool-description">{tool.description}</div>
              <details className="tool-schema">
                <summary>View Schema</summary>
                <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
              </details>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderWorkspaceFiles = () => {
    const { workspaceFiles } = contextInfo.breakdown;
    if (workspaceFiles.count === 0) {
      return (
        <div className="context-empty">No workspace files loaded</div>
      );
    }

    return (
      <div className="context-workspace-files">
        {workspaceFiles.note && (
          <div className="context-section-note">
            ℹ️ {workspaceFiles.note}
          </div>
        )}
        <div className="context-section-info">
          {workspaceFiles.count} workspace files (embedded in system prompt)
        </div>
        <div className="workspace-file-list">
          {workspaceFiles.files.map((file) => (
            <details key={file.name} className="workspace-file">
              <summary>
                <span className="file-name">{file.name}</span>
                <span className="file-size">
                  {formatNumber(Math.ceil(file.size / 4))} tokens
                </span>
              </summary>
              <pre className="file-content">{file.content}</pre>
            </details>
          ))}
        </div>
      </div>
    );
  };

  const renderSkills = () => {
    const { skills } = contextInfo.breakdown;
    if (skills.count === 0) {
      return <div className="context-empty">No skills enabled</div>;
    }

    return (
      <div className="context-skills">
        <div className="context-section-info">{skills.count} skills enabled</div>
        <div className="skill-list">
          {skills.skills.map((skill) => (
            <div key={skill.id} className="skill-item">
              <div className="skill-name">{skill.name}</div>
              <div className="skill-description">{skill.description}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderPlans = () => {
    const { plans } = contextInfo.breakdown;
    if (plans.count === 0) {
      return <div className="context-empty">No active plans</div>;
    }

    return (
      <div className="context-plans">
        <div className="context-section-info">{plans.count} active plans</div>
        <div className="plan-list">
          {plans.plans.map((plan) => (
            <details key={plan.planId} className="plan-item">
              <summary>{plan.title}</summary>
              <div className="plan-steps">
                {plan.steps.map((step) => (
                  <div key={step.id} className="plan-step">
                    <span className={`step-status step-${step.status}`}>
                      {step.status === "completed"
                        ? "✓"
                        : step.status === "in_progress"
                          ? "▶"
                          : "○"}
                    </span>
                    <span className="step-description">{step.description}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="context-inspector-overlay" onClick={onClose}>
      <div
        className="context-inspector-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="context-inspector-header">
          <h2>Context Inspector</h2>
          <button className="close-button" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="context-inspector-summary">
          <div className="summary-item">
            <span className="summary-label">Model:</span>
            <span className="summary-value">{contextInfo.model}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Total Tokens:</span>
            <span className="summary-value">
              {formatNumber(contextInfo.totalTokens)}
            </span>
          </div>
        </div>

        <div className="context-inspector-body">
          {renderSection(
            "system-prompt",
            "System Prompt",
            contextInfo.breakdown.systemPrompt.tokens,
            renderSystemPrompt(),
            "Includes workspace files",
          )}

          {contextInfo.breakdown.conversationSummary &&
            renderConversationSummary()}

          {renderSection(
            "messages",
            "Message History",
            contextInfo.breakdown.messages.tokens,
            renderMessages(),
          )}

          {renderSection(
            "tools",
            "Available Tools",
            contextInfo.breakdown.tools.tokens,
            renderTools(),
          )}

          {renderSection(
            "workspace",
            "Workspace Files",
            contextInfo.breakdown.workspaceFiles.tokens,
            renderWorkspaceFiles(),
            "In system prompt",
          )}

          {renderSection(
            "skills",
            "Active Skills",
            contextInfo.breakdown.skills.tokens,
            renderSkills(),
          )}

          {renderSection(
            "plans",
            "Active Plans",
            contextInfo.breakdown.plans.tokens,
            renderPlans(),
          )}
        </div>
      </div>
    </div>
  );
};
