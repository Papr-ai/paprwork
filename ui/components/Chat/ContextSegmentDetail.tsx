/**
 * What a segment actually contains. Kept to a preview: the full text of every
 * tool schema is the old inspector's job, and one click away from the footer.
 */

import React from "react";
import type { ContextInfo } from "./ContextInspectorModal";

const PREVIEW_CHARS = 2400;

function Preview({ text }: { text: string }) {
  return (
    <pre className="ctx-detail__pre">
      {text.slice(0, PREVIEW_CHARS)}
      {text.length > PREVIEW_CHARS ? "\n…" : ""}
    </pre>
  );
}

export const ContextSegmentDetail: React.FC<{
  segmentId: string;
  info: ContextInfo;
}> = ({ segmentId, info }) => {
  const b = info.breakdown;

  if (segmentId === "system") {
    return <Preview text={b.systemPrompt.content ?? ""} />;
  }

  if (segmentId === "summary") {
    return <Preview text={b.conversationSummary?.content ?? ""} />;
  }

  if (segmentId === "focus") {
    return <Preview text={b.focusContext?.content ?? ""} />;
  }

  if (segmentId === "workspace") {
    return (
      <ul className="ctx-detail__list">
        {b.workspaceFiles.files.map((file) => (
          <li key={file.name}>
            <span className="ctx-detail__name">{file.name}</span>
            <span className="ctx-detail__value">
              {Math.round(file.size / 4).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (segmentId === "tools") {
    return (
      <ul className="ctx-detail__list">
        {b.tools.schemas.map((tool) => (
          <li key={tool.id}>
            <span className="ctx-detail__name">{tool.id}</span>
            <span className="ctx-detail__value">
              {Math.round(JSON.stringify(tool).length / 4).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (segmentId === "memory") {
    const memory = b.memoryBootstrap;
    const rows = [
      ["Goals & OKRs", memory?.goalsOkrs?.tokens],
      ["Use cases", memory?.useCases?.tokens],
      ["Sync tiers", memory?.syncTiers?.tokens],
      ["Related memory", memory?.relatedMemory?.tokens],
    ].filter(([, tokens]) => typeof tokens === "number" && tokens > 0);

    return (
      <ul className="ctx-detail__list">
        {rows.map(([label, tokens]) => (
          <li key={String(label)}>
            <span className="ctx-detail__name">{label}</span>
            <span className="ctx-detail__value">
              {Number(tokens).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (segmentId === "messages") {
    const recent = b.messages.breakdown.slice(-12).reverse();
    return (
      <ul className="ctx-detail__list">
        {recent.map((msg, index) => (
          <li key={index}>
            <span className="ctx-detail__name">
              <span className="ctx-detail__role">{msg.role}</span>
              {msg.preview.slice(0, 70)}
            </span>
            <span className="ctx-detail__value">
              {msg.tokens.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return null;
};
