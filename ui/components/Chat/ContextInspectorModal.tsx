/**
 * Context inspector — the full read of the next prompt.
 *
 * One job: *show me exactly what is being sent, and let me find things in it.*
 *
 * The old version was nine stacked accordions, each with its own layout, and
 * every section closed by default — so the answer to "what is in my context"
 * was a list of nine questions. This is a rail and a page: pick a section on
 * the left, read it on the right, filter it from the top. Nothing folds.
 */

import React, { useEffect, useMemo, useState } from "react";
import { buildSections } from "./contextInspectorSections";
import "./ContextInspector.css";

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
  focusContext?: ContextSection & {
    content: string;
    resolved: {
      activeApp?: { appId: string; title: string; files?: string[] };
      activeJob?: { jobId: string; name: string; files?: string[] };
      lastEdited?: Array<{
        kind: string;
        path: string;
        appId?: string;
        jobId?: string;
        repoRoot?: string;
        filename?: string;
        editedAt: string;
      }>;
    } | null;
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
  /** Section to land on, when opened from a segment in the meter panel. */
  initialSection?: string | null;
  onClose: () => void;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

export const ContextInspectorModal: React.FC<ContextInspectorModalProps> = ({
  contextInfo,
  initialSection,
  onClose,
}) => {
  const sections = useMemo(() => buildSections(contextInfo), [contextInfo]);
  const [activeId, setActiveId] = useState(
    () => initialSection ?? sections[0]?.id ?? "",
  );
  /* Query is per-section: carrying "tool" across to the system prompt would
     silently hide most of it. */
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  const largest = Math.max(...sections.map((s) => s.tokens), 1);

  return (
    <div className="ctxi-overlay" onClick={onClose}>
      <div
        className="ctxi"
        role="dialog"
        aria-label="Context inspector"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ctxi__head">
          <div className="ctxi__heading">
            <h2>Context</h2>
            <p>
              {contextInfo.totalTokens.toLocaleString()} tokens in the next
              prompt · {contextInfo.model}
            </p>
          </div>
          <button
            type="button"
            className="ctxi__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="ctxi__body">
          <nav className="ctxi__rail" aria-label="Context sections">
            {sections.map((section) => (
              <button
                type="button"
                key={section.id}
                className={`ctxi__tab${section.id === active?.id ? " is-active" : ""}`}
                onClick={() => {
                  setActiveId(section.id);
                  setQuery("");
                }}
              >
                <span className="ctxi__tab-top">
                  <span className="ctxi__tab-title">{section.title}</span>
                  <span className="ctxi__tab-tokens">
                    {formatTokens(section.tokens)}
                  </span>
                </span>
                <span className="ctxi__tab-bar">
                  <i style={{ width: `${(section.tokens / largest) * 100}%` }} />
                </span>
              </button>
            ))}
          </nav>

          <section className="ctxi__pane">
            {active ? (
              <>
                <div className="ctxi__pane-head">
                  <div>
                    <h3>{active.title}</h3>
                    <p>
                      {active.tokens.toLocaleString()} tokens ·{" "}
                      {(
                        (active.tokens / (contextInfo.totalTokens || 1)) *
                        100
                      ).toFixed(1)}
                      % of prompt
                      {active.note ? ` · ${active.note}` : ""}
                    </p>
                  </div>
                  {active.searchable ? (
                    <input
                      className="ctxi__search"
                      type="search"
                      value={query}
                      placeholder="Find in section"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  ) : null}
                </div>
                <div className="ctxi__pane-body">{active.render(query)}</div>
              </>
            ) : (
              <p className="ctxi-empty">Nothing in this prompt yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
