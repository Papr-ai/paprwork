/**
 * Level three: read what is actually being sent.
 *
 * Every section is reduced to one of two shapes — a list of things you can
 * rank and filter, or a body of text you read. The old inspector had a
 * different layout per section, which meant nine small interfaces to learn
 * instead of two.
 */

import React, { useMemo, useState } from "react";
import { Markdown } from "../common/Markdown";
import {
  parseMemoryBootstrapBlock,
  type ParsedMemoryItem,
} from "./memoryBootstrapDisplay";
import type { ContextInfo } from "./ContextInspectorModal";

export interface Row {
  key: string;
  label: string;
  meta?: string;
  tokens: number;
  body?: string;
  /** Memory blocks are structured text — rendered as cards, not a blob. */
  renderBody?: () => React.ReactNode;
}

const MemoryCards: React.FC<{
  content: string;
  kind: "parse_goals" | "parse_usecases" | "sync_tiers" | "related_memory";
}> = ({ content, kind }) => {
  const parsed = useMemo(
    () => parseMemoryBootstrapBlock(content, kind),
    [content, kind],
  );

  return (
    <div className="ctxi-mem">
      {parsed.sections.map((section) => (
        <div key={section.title}>
          <h4 className="ctxi-mem__title">{section.title}</h4>
          {section.items.map((item: ParsedMemoryItem, index: number) => (
            <article className="ctxi-mem__card" key={index}>
              <div className="ctxi-mem__meta">
                {item.category ? <span>{item.category}</span> : null}
                {item.memoryType ? <span>{item.memoryType}</span> : null}
              </div>
              {item.title ? (
                <div className="ctxi-mem__name">{item.title}</div>
              ) : null}
              <Markdown>{item.body}</Markdown>
            </article>
          ))}
        </div>
      ))}
      {parsed.truncated ? (
        <p className="ctxi-empty">
          Truncated for the context limit — the full memories live in Papr.
        </p>
      ) : null}
    </div>
  );
};

/** Text sections filter by line, so search finds the passage, not the file. */
export const TextBody: React.FC<{ text: string; query: string }> = ({
  text,
  query,
}) => {
  const lines = useMemo(() => {
    if (!query.trim()) return null;
    const needle = query.toLowerCase();
    return text
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.toLowerCase().includes(needle));
  }, [text, query]);

  if (!text.trim()) {
    return <p className="ctxi-empty">Nothing in this section.</p>;
  }

  if (lines) {
    if (lines.length === 0) {
      return <p className="ctxi-empty">No lines match “{query}”.</p>;
    }
    return (
      <div className="ctxi-hits">
        {lines.slice(0, 300).map((entry) => (
          <div className="ctxi-hits__row" key={entry.index}>
            <span className="ctxi-hits__no">{entry.index + 1}</span>
            <span className="ctxi-hits__line">{entry.line}</span>
          </div>
        ))}
      </div>
    );
  }

  return <pre className="ctxi-text">{text}</pre>;
};

/**
 * Rows are ranked and bar-scaled to the largest of them. Tool schemas are the
 * case this exists for: 60 names and 60 numbers tell you nothing about which
 * one to delete.
 */
export const RowBody: React.FC<{ rows: Row[]; query: string }> = ({
  rows,
  query,
}) => {
  const [open, setOpen] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.label.toLowerCase().includes(needle) ||
            (row.body ?? "").toLowerCase().includes(needle),
        )
      : rows;
    return [...filtered].sort((a, b) => b.tokens - a.tokens);
  }, [rows, query]);

  if (rows.length === 0) {
    return <p className="ctxi-empty">Nothing in this section.</p>;
  }
  if (visible.length === 0) {
    return <p className="ctxi-empty">No matches for “{query}”.</p>;
  }

  const peak = visible[0]?.tokens || 1;

  return (
    <div className="ctxi-rows">
      {visible.map((row) => {
        const isOpen = open === row.key;
        return (
          <div className={`ctxi-row${isOpen ? " is-open" : ""}`} key={row.key}>
            <button
              type="button"
              className="ctxi-row__head"
              onClick={() => setOpen(isOpen ? null : row.key)}
              aria-expanded={isOpen}
            >
              <span
                className="ctxi-row__bar"
                style={{ width: `${Math.max((row.tokens / peak) * 100, 3)}%` }}
              />
              {row.meta ? (
                <span className="ctxi-row__meta">{row.meta}</span>
              ) : null}
              <span className="ctxi-row__label">{row.label}</span>
              <span className="ctxi-row__tokens">
                {row.tokens.toLocaleString()}
              </span>
            </button>
            {isOpen && row.renderBody ? (
              <div className="ctxi-row__body">{row.renderBody()}</div>
            ) : isOpen && row.body ? (
              <pre className="ctxi-row__body">{row.body}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export interface Section {
  id: string;
  title: string;
  tokens: number;
  note?: string;
  searchable: boolean;
  render: (query: string) => React.ReactNode;
}

/** Ordered by what the reader is most likely chasing, not by size. */
export function buildSections(info: ContextInfo): Section[] {
  const b = info.breakdown;
  const sections: Section[] = [];

  const text = (
    id: string,
    title: string,
    tokens: number,
    content: string,
    note?: string,
  ) =>
    sections.push({
      id,
      title,
      tokens,
      note,
      searchable: true,
      render: (query) => <TextBody text={content} query={query} />,
    });

  const list = (
    id: string,
    title: string,
    tokens: number,
    rows: Row[],
    note?: string,
  ) =>
    sections.push({
      id,
      title,
      tokens,
      note,
      searchable: true,
      render: (query) => <RowBody rows={rows} query={query} />,
    });

  list(
    "messages",
    "Conversation",
    b.messages.tokens,
    b.messages.breakdown.map((msg, index) => ({
      key: `msg-${index}`,
      label: msg.preview || "(empty)",
      meta: msg.role,
      tokens: msg.tokens,
      body: msg.preview,
    })),
    `${b.messages.count ?? 0} messages`,
  );

  if (b.conversationSummary) {
    text(
      "summary",
      "Summarized earlier turns",
      b.conversationSummary.tokens,
      b.conversationSummary.content ?? "",
    );
  }

  if (b.memoryBootstrap) {
    const m = b.memoryBootstrap;
    const blocks: Row[] = (
      [
        ["Goals & OKRs", m.goalsOkrs, "parse_goals"],
        ["Use cases", m.useCases, "parse_usecases"],
        ["Sync tiers", m.syncTiers, "sync_tiers"],
        ["Related memory", m.relatedMemory, "related_memory"],
      ] as const
    )
      .filter(([, block]) => Boolean(block))
      .map(([label, block, kind]) => {
        const value = block as { tokens: number; content: string };
        return {
          key: label,
          label,
          tokens: value.tokens,
          body: value.content,
          renderBody: () => <MemoryCards content={value.content} kind={kind} />,
        };
      });
    list(
      "memory",
      "Papr memory",
      m.tokens,
      blocks,
      m.deferredBootstrap
        ? "Injects on next send"
        : m.wouldRunOnNextTurn
          ? "Loads in background"
          : "Not on next send",
    );
  }

  list(
    "tools",
    "Tool definitions",
    b.tools.tokens,
    b.tools.schemas.map((tool) => ({
      key: tool.id,
      label: tool.id,
      tokens: Math.round(JSON.stringify(tool).length / 4),
      body: `${tool.description}\n\n${JSON.stringify(tool.parameters, null, 2)}`,
    })),
    `${b.tools.count ?? 0} tools`,
  );

  const workspaceTokens = b.workspaceFiles?.tokens ?? 0;
  text(
    "system",
    "System prompt",
    Math.max(b.systemPrompt.tokens - workspaceTokens, 0),
    b.systemPrompt.content ?? "",
    "Workspace rules listed separately",
  );

  list(
    "workspace",
    "Workspace rules",
    workspaceTokens,
    (b.workspaceFiles?.files ?? []).map((file) => ({
      key: file.name,
      label: file.name,
      tokens: Math.round(file.size / 4),
      body: file.content,
    })),
    `${b.workspaceFiles?.count ?? 0} files`,
  );

  if (b.focusContext && b.focusContext.tokens > 0) {
    text(
      "focus",
      "Focus context",
      b.focusContext.tokens,
      b.focusContext.content ?? "",
      "What the UI is pointing at",
    );
  }

  if ((b.skills?.count ?? 0) > 0) {
    list(
      "skills",
      "Skills",
      b.skills.tokens,
      b.skills.skills.map((skill) => ({
        key: skill.id,
        label: skill.name,
        tokens: 0,
        body: skill.description,
      })),
      `${b.skills.count} enabled`,
    );
  }

  if ((b.plans?.count ?? 0) > 0) {
    list(
      "plans",
      "Plans",
      b.plans.tokens,
      b.plans.plans.map((plan) => ({
        key: plan.planId,
        label: plan.title,
        tokens: 0,
        body: plan.steps
          .map(
            (step) =>
              `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "○"} ${step.description}`,
          )
          .join("\n"),
      })),
      `${b.plans.count} active`,
    );
  }

  /* Diagnostics, not prompt content — last in the rail, and the one section
     with no token bar to earn, because it costs nothing to send. */
  if (b.paprSync) {
    const sync = b.paprSync;
    const counts = sync.messageCounts;
    const stats: Array<[string, string]> = [
      ["Storage", sync.storageMode],
      ["Cloud sync", sync.syncEnabled ? "On" : "Off"],
      ["Papr key", sync.paprConfigured ? "Configured" : "Missing"],
      ["Bootstrap next turn", sync.memoryBootstrapOnNextTurn ? "Yes" : "No"],
      [
        "Summary in context",
        sync.conversationSummaryInContext
          ? "Yes"
          : sync.hasLocalSummary
            ? "Cached only"
            : "No",
      ],
      [
        "Messages",
        `${counts.synced}/${counts.total} synced · ${counts.sync_pending + counts.sync_failed} pending`,
      ],
    ];

    sections.push({
      id: "sync",
      title: "Sync status",
      tokens: 0,
      note: "Diagnostics",
      searchable: false,
      render: () => (
        <div className="ctxi-stats">
          {stats.map(([label, value]) => (
            <div className="ctxi-stats__row" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
          {sync.recentSyncFailures.length > 0 ? (
            <div className="ctxi-stats__fail">
              {sync.recentSyncFailures.map((failure) => (
                <div key={failure.messageId}>
                  {failure.timestamp.slice(0, 19)} — {failure.error}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ),
    });
  }

  return sections;
}
