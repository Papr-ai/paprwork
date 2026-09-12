/**
 * Level two: what is inside one segment.
 *
 * One job — *show what is big*. A column of names and numbers makes the reader
 * do the comparison; a ranked bar does it for them, so the largest item is
 * obvious before a single figure is read.
 *
 * Prose segments have no parts to rank, so they get the other shape: three
 * lines of the real text and one way out to the full read. Dumping 2,400
 * characters of monospace into a 190px box was never a second level — it was
 * the third level, arriving early and badly.
 */

import React from "react";
import type { ContextInfo } from "./ContextInspectorModal";
import { formatTokens, type ContextSegment } from "./contextMeterModel";

/** Five rows fit without a scrollbar; the rest is the inspector's job. */
const TOP_N = 5;
const EXCERPT_CHARS = 260;

interface RankRow {
  key: string;
  label: string;
  meta?: string;
  tokens: number;
}

function toRows(segmentId: string, info: ContextInfo): RankRow[] | null {
  const b = info.breakdown;

  if (segmentId === "tools") {
    return b.tools.schemas.map((tool) => ({
      key: tool.id,
      label: tool.id,
      tokens: Math.round(JSON.stringify(tool).length / 4),
    }));
  }

  if (segmentId === "workspace") {
    return b.workspaceFiles.files.map((file) => ({
      key: file.name,
      label: file.name,
      tokens: Math.round(file.size / 4),
    }));
  }

  if (segmentId === "messages") {
    return b.messages.breakdown.map((msg, index) => ({
      key: `${index}-${msg.role}`,
      label: msg.preview.slice(0, 64) || "(empty)",
      meta: msg.role,
      tokens: msg.tokens,
    }));
  }

  if (segmentId === "memory") {
    const m = b.memoryBootstrap;
    return [
      { key: "goals", label: "Goals & OKRs", tokens: m?.goalsOkrs?.tokens ?? 0 },
      { key: "cases", label: "Use cases", tokens: m?.useCases?.tokens ?? 0 },
      { key: "tiers", label: "Sync tiers", tokens: m?.syncTiers?.tokens ?? 0 },
      {
        key: "related",
        label: "Related memory",
        tokens: m?.relatedMemory?.tokens ?? 0,
      },
    ].filter((row) => row.tokens > 0);
  }

  return null;
}

function proseFor(segmentId: string, info: ContextInfo): string {
  const b = info.breakdown;
  if (segmentId === "system") return b.systemPrompt.content ?? "";
  if (segmentId === "summary") return b.conversationSummary?.content ?? "";
  if (segmentId === "focus") return b.focusContext?.content ?? "";
  return "";
}

export const ContextSegmentDetail: React.FC<{
  segment: ContextSegment;
  info: ContextInfo;
  onOpenFull: (sectionId: string) => void;
}> = ({ segment, info, onOpenFull }) => {
  const rows = toRows(segment.id, info);

  if (!rows) {
    const text = proseFor(segment.id, info).replace(/\s+/g, " ").trim();
    if (!text) return null;
    return (
      <div className="ctx-excerpt">
        <p className="ctx-excerpt__text">
          {text.slice(0, EXCERPT_CHARS)}
          {text.length > EXCERPT_CHARS ? "…" : ""}
        </p>
        <button
          type="button"
          className="ctx-more"
          onClick={() => onOpenFull(segment.id)}
        >
          Read the full text
        </button>
      </div>
    );
  }

  const ranked = [...rows].sort((a, b) => b.tokens - a.tokens);
  const shown = ranked.slice(0, TOP_N);
  const rest = ranked.slice(TOP_N);
  /* Scaled to the largest item, not to the segment total: at prompt scale the
     share-of-total bars would all be hairlines and rank nothing. */
  const peak = shown[0]?.tokens || 1;
  const restTokens = rest.reduce((sum, row) => sum + row.tokens, 0);

  return (
    <div className="ctx-rank">
      {shown.map((row) => (
        <div className="ctx-rank__row" key={row.key} title={row.label}>
          <span
            className={`ctx-rank__bar ctx-rank__bar--${segment.tone}`}
            style={{ width: `${Math.max((row.tokens / peak) * 100, 4)}%` }}
          />
          <span className="ctx-rank__label">
            {row.meta ? <em className="ctx-rank__meta">{row.meta}</em> : null}
            {row.label}
          </span>
          <span className="ctx-rank__tokens">{formatTokens(row.tokens)}</span>
        </div>
      ))}
      {rest.length > 0 ? (
        <button
          type="button"
          className="ctx-more"
          onClick={() => onOpenFull(segment.id)}
        >
          {rest.length} more · {formatTokens(restTokens)}
        </button>
      ) : null}
    </div>
  );
};
