/**
 * ContextInspectorModal - Shows detailed breakdown of what's sent to the LLM
 * 
 * Displays:
 * - Total token count
 * - System prompt
 * - Conversation summary (if present)
 * - Papr memory bootstrap (sync tiers + related search)
 * - Message history
 * - Tool schemas
 * - Workspace files (.md files)
 * - Active skills
 * - Active plans
 */

import React, { useState } from "react";
import { Markdown } from "../common/Markdown";
import {
  parseMemoryBootstrapBlock,
  type ParsedMemoryItem,
} from "./memoryBootstrapDisplay";
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
  memoryBootstrap?: ContextSection & {
    wouldRunOnNextTurn: boolean;
    deferredBootstrap?: boolean;
    goalsOkrs: { tokens: number; content: string } | null;
    useCases: { tokens: number; content: string } | null;
    syncTiers: { tokens: number; content: string } | null;
    relatedMemory: { tokens: number; content: string } | null;
  };
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
  paprSync?: ContextSection & {
    storageMode: string;
    syncEnabled: boolean;
    paprConfigured: boolean;
    paprUserId: string | null;
    hasLocalSummary: boolean;
    conversationSummaryInContext: boolean;
    memoryBootstrapOnNextTurn: boolean;
    messageCounts: {
      total: number;
      synced: number;
      sync_pending: number;
      sync_failed: number;
      local: number;
      papr_only: number;
    };
    recentSyncFailures: Array<{
      messageId: string;
      error: string;
      timestamp: string;
    }>;
  };
}

export interface ContextInfo {
  model: string;
  totalTokens: number;
  breakdown: ContextBreakdown;
}

export function isContextInfo(data: unknown): data is ContextInfo {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    typeof record.model === "string" &&
    typeof record.totalTokens === "number" &&
    typeof record.breakdown === "object" &&
    record.breakdown !== null
  );
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

  const renderMemoryItem = (item: ParsedMemoryItem, index: number) => (
    <article key={index} className="memory-item-card">
      <div className="memory-item-meta">
        {item.category ? (
          <span className="memory-item-badge">{item.category}</span>
        ) : null}
        {item.memoryType ? (
          <span className="memory-item-type">{item.memoryType}</span>
        ) : null}
        {item.sessionId ? (
          <span className="memory-item-session" title={item.sessionId}>
            Session {item.sessionId.slice(0, 8)}…
          </span>
        ) : null}
      </div>
      {item.title ? (
        <div className="memory-item-title">{item.title}</div>
      ) : null}
      <div className="memory-item-body">
        <Markdown>{item.body}</Markdown>
      </div>
    </article>
  );

  const renderParsedMemoryBlock = (
    content: string,
    kind: "sync_tiers" | "related_memory",
    tokenCount: number,
    summaryLabel: string,
    defaultOpen: boolean,
  ) => {
    const parsed = parseMemoryBootstrapBlock(content, kind);
    const itemCount = parsed.sections.reduce(
      (sum, section) => sum + section.items.length,
      0,
    );

    return (
      <details className="memory-block-details" open={defaultOpen}>
        <summary>
          {summaryLabel} — {formatNumber(tokenCount)} tokens ({itemCount}{" "}
          {itemCount === 1 ? "memory" : "memories"})
        </summary>
        <div className="memory-block-parsed">
          <p className="memory-block-intro">{parsed.intro}</p>
          {parsed.sections.map((section) => (
            <div key={section.title} className="memory-section">
              <h4 className="memory-section-title">{section.title}</h4>
              <div className="memory-item-list">
                {section.items.map((item, index) =>
                  renderMemoryItem(item, index),
                )}
              </div>
            </div>
          ))}
          {parsed.truncated ? (
            <p className="memory-block-truncated">
              Block truncated for context limits — full memories live in Papr.
            </p>
          ) : null}
          {parsed.footer ? (
            <p className="memory-block-footer">{parsed.footer}</p>
          ) : null}
        </div>
      </details>
    );
  };

  const renderMemoryBootstrap = () => {
    const memoryBootstrap = contextInfo.breakdown.memoryBootstrap;
    if (!memoryBootstrap) {
      return null;
    }

    const statusNote = memoryBootstrap.deferredBootstrap
      ? "Injects on next send"
      : memoryBootstrap.wouldRunOnNextTurn
        ? "Loads in background (2nd message)"
        : "Skipped on next send";

    return renderSection(
      "memory-bootstrap",
      "Papr Memory Bootstrap",
      memoryBootstrap.tokens,
      <div className="context-memory-bootstrap">
        {memoryBootstrap.note && (
          <div className="context-section-note">ℹ️ {memoryBootstrap.note}</div>
        )}
        <div className="context-section-info">
          {memoryBootstrap.deferredBootstrap
            ? "Ready to inject on your next message — fetched in the background while the agent replied to your first message."
            : memoryBootstrap.wouldRunOnNextTurn
              ? "First message starts a background fetch (Parse goals, use cases, sync tiers). The agent responds immediately; context injects on your second message."
              : "Bootstrap already injected this session, or no pending fetch"}
        </div>
        {memoryBootstrap.goalsOkrs
          ? renderParsedMemoryBlock(
              memoryBootstrap.goalsOkrs.content,
              "parse_goals",
              memoryBootstrap.goalsOkrs.tokens,
              "Goals & OKRs (Parse Goal)",
              true,
            )
          : memoryBootstrap.wouldRunOnNextTurn ? (
            <div className="context-empty">
              No Parse goals (need Papr login session token)
            </div>
          ) : null}
        {memoryBootstrap.useCases
          ? renderParsedMemoryBlock(
              memoryBootstrap.useCases.content,
              "parse_usecases",
              memoryBootstrap.useCases.tokens,
              "Use cases (Parse Usecase)",
              false,
            )
          : null}
        {memoryBootstrap.syncTiers
          ? renderParsedMemoryBlock(
              memoryBootstrap.syncTiers.content,
              "sync_tiers",
              memoryBootstrap.syncTiers.tokens,
              "Sync tiers",
              true,
            )
          : (
            <div className="context-empty">No sync tier block on next turn</div>
          )}
        {memoryBootstrap.relatedMemory
          ? renderParsedMemoryBlock(
              memoryBootstrap.relatedMemory.content,
              "related_memory",
              memoryBootstrap.relatedMemory.tokens,
              "Related memory search",
              false,
            )
          : memoryBootstrap.wouldRunOnNextTurn ? (
            <div className="context-empty">
              No related memory matches for this query
            </div>
          ) : null}
      </div>,
      statusNote,
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

  const renderPaprSync = () => {
    const paprSync = contextInfo.breakdown.paprSync;
    if (!paprSync) {
      return <div className="context-empty">Sync status unavailable</div>;
    }

    const { messageCounts } = paprSync;
    const pendingTotal =
      messageCounts.sync_pending + messageCounts.sync_failed;

    return (
      <div className="context-papr-sync">
        {paprSync.note && (
          <div className="context-section-note">ℹ️ {paprSync.note}</div>
        )}
        <div className="sync-status-grid">
          <div className="sync-status-item">
            <span className="sync-label">Storage mode</span>
            <span className="sync-value">{paprSync.storageMode}</span>
          </div>
          <div className="sync-status-item">
            <span className="sync-label">Cloud sync</span>
            <span className="sync-value">
              {paprSync.syncEnabled ? "Enabled (hybrid)" : "Disabled"}
            </span>
          </div>
          <div className="sync-status-item">
            <span className="sync-label">Papr API key</span>
            <span className="sync-value">
              {paprSync.paprConfigured ? "Configured" : "Not configured"}
            </span>
          </div>
          <div className="sync-status-item">
            <span className="sync-label">Papr user ID</span>
            <span className="sync-value">
              {paprSync.paprUserId ?? "Not set"}
            </span>
          </div>
          <div className="sync-status-item">
            <span className="sync-label">Memory bootstrap (next turn)</span>
            <span className="sync-value">
              {paprSync.memoryBootstrapOnNextTurn ? "Would run" : "Skipped"}
            </span>
          </div>
          <div className="sync-status-item">
            <span className="sync-label">Summary in context</span>
            <span className="sync-value">
              {paprSync.conversationSummaryInContext
                ? "Yes (from Papr)"
                : paprSync.hasLocalSummary
                  ? "Cached locally (not in this turn)"
                  : "No"}
            </span>
          </div>
        </div>

        <div className="context-section-info">
          {messageCounts.total} messages — {messageCounts.synced} synced,{" "}
          {messageCounts.sync_pending} pending, {messageCounts.sync_failed}{" "}
          failed, {messageCounts.local} local-only
          {pendingTotal > 0 && (
            <span className="sync-warning">
              {" "}
              ({pendingTotal} need sync)
            </span>
          )}
        </div>

        {paprSync.recentSyncFailures.length > 0 && (
          <div className="sync-failures">
            <div className="sync-failures-title">Recent sync failures</div>
            {paprSync.recentSyncFailures.map((failure) => (
              <div key={failure.messageId} className="sync-failure-item">
                <span className="sync-failure-time">
                  {failure.timestamp.substring(0, 19)}
                </span>
                <span className="sync-failure-error">{failure.error}</span>
              </div>
            ))}
          </div>
        )}
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

          {renderMemoryBootstrap()}

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

          {contextInfo.breakdown.paprSync &&
            renderSection(
              "papr-sync",
              "Papr Sync & Memory",
              0,
              renderPaprSync(),
              "Sync status only",
            )}
        </div>
      </div>
    </div>
  );
};
