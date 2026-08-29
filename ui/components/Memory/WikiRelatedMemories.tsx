import React, { useEffect, useMemo, useState } from "react";
import { Markdown } from "../common/Markdown";
import type { WikiRelatedMemory } from "../../types/wiki";
import { formatUpdatedAt } from "../../utils/wikiSectionUtils";
import "./WikiRelatedMemories.css";

const PREVIEW_CHAR_LIMIT = 220;

function memoryTitle(content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return firstLine?.replace(/^[-*]\s+/, "").slice(0, 80) || "Memory";
}

function memoryPreviewPlain(content: string, maxLen = PREVIEW_CHAR_LIMIT): string {
  const plain = content
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen).trim()}…`;
}

function RelatedMemoryModal({
  memory,
  onClose,
}: {
  memory: WikiRelatedMemory;
  onClose: () => void;
}) {
  const title = memoryTitle(memory.content);
  const updatedLabel = formatUpdatedAt(memory.createdAt ?? null);

  return (
    <div
      className="wiki-memory-modal__backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="wiki-memory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wiki-memory-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wiki-memory-modal__header">
          <div>
            <div className="wiki-memory-modal__eyebrow">
              {memory.category || "memory"}
              {updatedLabel ? ` · ${updatedLabel}` : ""}
            </div>
            <h2 id="wiki-memory-modal-title">{title}</h2>
          </div>
          <button
            type="button"
            className="wiki-memory-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="wiki-memory-modal__body">
          <Markdown>{memory.content}</Markdown>
        </div>
      </div>
    </div>
  );
}

function RelatedMemoryCard({
  memory,
  onOpen,
}: {
  memory: WikiRelatedMemory;
  onOpen: () => void;
}) {
  const title = memoryTitle(memory.content);
  const preview = memoryPreviewPlain(memory.content);
  const updatedLabel = formatUpdatedAt(memory.createdAt ?? null);
  const needsExpand = memory.content.length > PREVIEW_CHAR_LIMIT;

  return (
    <article className="wiki-related-memory-card">
      <div className="wiki-related-memory-card__header">
        <span className="wiki-related-memory-card__category">
          {memory.category || "memory"}
        </span>
        {updatedLabel ? (
          <span className="wiki-related-memory-card__updated">{updatedLabel}</span>
        ) : null}
      </div>
      <h4 className="wiki-related-memory-card__title">{title}</h4>
      <div className="wiki-related-memory-card__preview">
        <Markdown>{preview}</Markdown>
      </div>
      {needsExpand ? (
        <button
          type="button"
          className="wiki-related-memory-card__more"
          onClick={onOpen}
        >
          Read more
        </button>
      ) : (
        <button
          type="button"
          className="wiki-related-memory-card__more"
          onClick={onOpen}
        >
          Open
        </button>
      )}
    </article>
  );
}

export function RelatedMemoriesPanel({
  memories,
}: {
  memories: WikiRelatedMemory[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeMemory = useMemo(
    () => memories.find((memory) => memory.id === activeId) ?? null,
    [activeId, memories],
  );

  useEffect(() => {
    if (!activeId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId]);

  if (!memories.length) return null;

  return (
    <>
      <div className="wiki-entity__related">
        <h3>Related Memories</h3>
        <div className="wiki-related-memories-grid">
          {memories.map((memory) => (
            <RelatedMemoryCard
              key={memory.id}
              memory={memory}
              onOpen={() => setActiveId(memory.id)}
            />
          ))}
        </div>
      </div>
      {activeMemory ? (
        <RelatedMemoryModal
          memory={activeMemory}
          onClose={() => setActiveId(null)}
        />
      ) : null}
    </>
  );
}
