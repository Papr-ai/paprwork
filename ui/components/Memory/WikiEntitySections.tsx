import React, { useCallback, useMemo, useState } from "react";
import { Markdown } from "../common/Markdown";
import { gateway } from "../../src/lib/gateway";
import type { WikiNode } from "../../types/wiki";
import { wikiTypeMeta } from "../../types/wiki";
import {
  collectGoalNodes,
  formatLastUpdated,
  formatUpdatedAt,
  isIdentitySectionPlaceholder,
  isKeyDetailImageValue,
  isPlaceholderSection,
  KEY_DETAIL_IMAGE_KEYS,
  KEY_DETAIL_LINK_KEYS,
  OPEN_ITEM_CATEGORY_LABELS,
  parseChangelogEntries,
  parseDecisions,
  parseKeyDetailRows,
  parseOpenItems,
  resolveWikiNodeByRef,
  splitEntityMentions,
  STRUCTURED_SECTION_ORDER,
} from "../../utils/wikiSectionUtils";
import { WikiTasksView } from "./WikiTasksView";
export { WikiTasksView } from "./WikiTasksView";
import "./WikiEntitySections.css";

interface WikiEntitySectionsProps {
  node: WikiNode;
  sections: Record<string, string>;
  allNodes: WikiNode[];
  onPick: (node: WikiNode) => void;
  onSectionsChanged?: () => void;
}

function EntityMentionCard({
  refId,
  label,
  allNodes,
  onPick,
}: {
  refId: string;
  label?: string;
  allNodes: WikiNode[];
  onPick: (node: WikiNode) => void;
}) {
  const target = resolveWikiNodeByRef(refId, allNodes);
  const meta = target ? wikiTypeMeta(target.type) : null;
  const display = label ?? target?.label ?? refId.split("/").pop() ?? refId;

  if (!target) {
    return (
      <span className="wiki-entity-mention wiki-entity-mention--missing">
        {display}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="wiki-entity-mention"
      onClick={() => onPick(target)}
      style={
        meta
          ? ({ "--mention-color": meta.color } as React.CSSProperties)
          : undefined
      }
    >
      <span className="wiki-entity-mention__glyph">{meta?.glyph ?? "◆"}</span>
      <span className="wiki-entity-mention__type">{meta?.label ?? "Entity"}</span>
      <span className="wiki-entity-mention__label">{display}</span>
    </button>
  );
}

function RichSectionText({
  text,
  allNodes,
  onPick,
}: {
  text: string;
  allNodes: WikiNode[];
  onPick: (node: WikiNode) => void;
}) {
  const segments = splitEntityMentions(text);
  const hasEntityLinks = segments.some((segment) => segment.kind === "entity");
  if (!hasEntityLinks) {
    return <Markdown>{text}</Markdown>;
  }

  return (
    <div className="wiki-rich-text">
      {segments.map((segment, index) =>
        segment.kind === "entity" && segment.entityRef ? (
          <EntityMentionCard
            key={`entity-${index}`}
            refId={segment.entityRef}
            label={segment.entityLabel}
            allNodes={allNodes}
            onPick={onPick}
          />
        ) : (
          <Markdown key={`text-${index}`}>{segment.value}</Markdown>
        ),
      )}
    </div>
  );
}

function GenericSectionCard({
  title,
  content,
  allNodes,
  onPick,
}: {
  title: string;
  content: string;
  allNodes: WikiNode[];
  onPick: (node: WikiNode) => void;
}) {
  return (
    <article className="wiki-section-card">
      <header className="wiki-section-card__header">
        <h3>{title}</h3>
      </header>
      <div className="wiki-section-card__body">
        <RichSectionText text={content} allNodes={allNodes} onPick={onPick} />
      </div>
    </article>
  );
}

function KeyDetailsSection({ content }: { content: string }) {
  const rows = useMemo(() => parseKeyDetailRows(content), [content]);
  if (!rows.length) return null;

  return (
    <article className="wiki-section-card wiki-section-card--details">
      <header className="wiki-section-card__header">
        <h3>Key Details</h3>
      </header>
      <dl className="wiki-key-details">
        {rows.map((row) => {
          const isImageKey =
            KEY_DETAIL_IMAGE_KEYS.has(row.key) || isKeyDetailImageValue(row.value);
          const isLinkKey =
            KEY_DETAIL_LINK_KEYS.has(row.key) ||
            /^https?:\/\//i.test(row.value);

          return (
            <div key={`${row.key}-${row.label}`} className="wiki-key-detail">
              <dt>{row.label}</dt>
              <dd>
                {isImageKey && isKeyDetailImageValue(row.value) ? (
                  <img
                    className="wiki-key-detail__image"
                    src={row.value}
                    alt={`${row.label} preview`}
                    loading="lazy"
                  />
                ) : isLinkKey && /^https?:\/\//i.test(row.value) ? (
                  <a href={row.value} target="_blank" rel="noreferrer noopener">
                    {row.value}
                  </a>
                ) : (
                  row.value
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </article>
  );
}

function OpenItemsSection({
  node,
  content,
  onSectionsChanged,
}: {
  node: WikiNode;
  content: string;
  onSectionsChanged?: () => void;
}) {
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => parseOpenItems(content), [content]);
  const openCount = items.filter((item) => !item.completed).length;

  const toggleItem = useCallback(
    async (fileIndex: number, completed: boolean) => {
      setBusyIndex(fileIndex);
      setError(null);
      try {
        const response = await gateway.send(
          "memory:wiki-toggle-open-item",
          {
            type: node.type,
            id: node.id,
            itemIndex: fileIndex,
            completed,
          },
          { timeoutMs: 15_000 },
        );
        if (!response.success) {
          throw new Error(response.error ?? "Could not update item");
        }
        onSectionsChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update item");
      } finally {
        setBusyIndex(null);
      }
    },
    [node.id, node.type, onSectionsChanged],
  );

  if (!items.length) return null;

  return (
    <article className="wiki-section-card wiki-section-card--tasks">
      <header className="wiki-section-card__header">
        <h3>Open Items</h3>
        <span className="wiki-section-card__meta">
          {openCount} open · {items.length - openCount} done
        </span>
      </header>
      {error ? (
        <p className="wiki-section-card__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wiki-open-items">
        {items.map((item) => (
          <label
            key={`${item.fileIndex}-${item.text}`}
            className={`wiki-open-item${item.completed ? " wiki-open-item--done" : ""}`}
          >
            <input
              type="checkbox"
              checked={item.completed}
              disabled={busyIndex === item.fileIndex}
              onChange={(event) => {
                void toggleItem(item.fileIndex, event.target.checked);
              }}
            />
            <span className="wiki-open-item__text">{item.text}</span>
            {item.category !== "uncategorized" ? (
              <span
                className={`wiki-open-item__category wiki-open-item__category--${item.category}`}
              >
                {OPEN_ITEM_CATEGORY_LABELS[item.category]}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </article>
  );
}

function DecisionsSection({ content }: { content: string }) {
  const decisions = useMemo(() => parseDecisions(content), [content]);
  const openCount = decisions.filter((item) => item.status === "open").length;

  if (!decisions.length) return null;

  return (
    <article className="wiki-section-card wiki-section-card--decisions">
      <header className="wiki-section-card__header">
        <h3>Decisions</h3>
        <span className="wiki-section-card__meta">
          {openCount} open · {decisions.length - openCount} decided
        </span>
      </header>
      <div className="wiki-decisions">
        {decisions.map((decision, index) => (
          <article
            key={`${index}-${decision.text}`}
            className={`wiki-decision-card wiki-decision-card--${decision.status}`}
          >
            <div className="wiki-decision-card__head">
              <span className="wiki-decision-card__status">
                {decision.status === "open" ? "Open" : "Decided"}
              </span>
            </div>
            <p className="wiki-decision-card__text">{decision.text}</p>
            {decision.owner ? (
              <div className="wiki-decision-card__meta-row">
                <span className="wiki-decision-card__label">Owner</span>
                <span>{decision.owner}</span>
              </div>
            ) : null}
            {decision.evidence ? (
              <div className="wiki-decision-card__meta-row">
                <span className="wiki-decision-card__label">Evidence</span>
                <span>{decision.evidence}</span>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </article>
  );
}

function IdentityGoalsSection({
  goals,
  onPick,
}: {
  goals: WikiNode[];
  onPick: (node: WikiNode) => void;
}) {
  if (!goals.length) return null;

  return (
    <article className="wiki-section-card wiki-section-card--identity-goals">
      <header className="wiki-section-card__header">
        <h3>Goals</h3>
        <span className="wiki-section-card__meta">
          From your knowledge graph · Sleep keeps IDENTITY in sync
        </span>
      </header>
      <div className="wiki-identity-goals">
        {goals.map((goal) => {
          const meta = wikiTypeMeta(goal.type);
          const status = goal.props?.status ? String(goal.props.status) : null;
          const progress =
            goal.props?.progress != null ? String(goal.props.progress) : null;
          const priority =
            goal.props?.priority != null ? String(goal.props.priority) : null;
          return (
            <button
              key={`${goal.type}:${goal.id}`}
              type="button"
              className="wiki-identity-goal"
              onClick={() => onPick(goal)}
              style={
                { "--goal-color": meta.color } as React.CSSProperties
              }
            >
              <div className="wiki-identity-goal__head">
                <span className="wiki-identity-goal__type">{meta.label}</span>
                {status ? (
                  <span className="wiki-identity-goal__pill">{status}</span>
                ) : null}
                {progress ? (
                  <span className="wiki-identity-goal__pill">{progress}</span>
                ) : null}
                {priority ? (
                  <span className="wiki-identity-goal__pill">
                    P{priority}
                  </span>
                ) : null}
              </div>
              <div className="wiki-identity-goal__title">{goal.label}</div>
              {goal.description ? (
                <p className="wiki-identity-goal__desc">{goal.description}</p>
              ) : null}
            </button>
          );
        })}
      </div>
    </article>
  );
}

function ChangelogSection({ content }: { content: string }) {
  const entries = useMemo(() => parseChangelogEntries(content), [content]);
  const [index, setIndex] = useState(0);

  if (!entries.length) return null;

  const safeIndex = Math.min(index, entries.length - 1);
  const entry = entries[safeIndex];
  const isLatest = safeIndex === 0;

  return (
    <article className="wiki-section-card wiki-section-card--changelog">
      <header className="wiki-section-card__header">
        <div className="wiki-section-card__heading">
          <h3>Changelog</h3>
          {isLatest ? (
            <span className="wiki-changelog-badge">Latest</span>
          ) : null}
        </div>
        <span className="wiki-section-card__meta">
          {safeIndex + 1} of {entries.length}
        </span>
      </header>
      <div className="wiki-changelog-card">
        <div className="wiki-changelog-card__date">{entry.date}</div>
        <p className="wiki-changelog-card__text">{entry.text}</p>
      </div>
      {entries.length > 1 ? (
        <>
          <div className="wiki-changelog-dots" aria-hidden>
            {entries.map((_, dotIndex) => (
              <span
                key={dotIndex}
                className={`wiki-changelog-dot${dotIndex === safeIndex ? " wiki-changelog-dot--active" : ""}`}
              />
            ))}
          </div>
          <div className="wiki-changelog-nav">
            <button
              type="button"
              className="wiki-changelog-nav__btn"
              disabled={safeIndex >= entries.length - 1}
              onClick={() =>
                setIndex((value) => Math.min(entries.length - 1, value + 1))
              }
              aria-label="Older entry"
            >
              ← Older
            </button>
            <button
              type="button"
              className="wiki-changelog-nav__btn"
              disabled={safeIndex <= 0}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              aria-label="Newer entry"
            >
              Newer →
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}

export function WikiEntitySections({
  node,
  sections,
  allNodes,
  onPick,
  onSectionsChanged,
}: WikiEntitySectionsProps) {
  return (
    <div className="wiki-entity-sections">
      {STRUCTURED_SECTION_ORDER.map((title) => {
        const content = sections[title];
        if (!content || isPlaceholderSection(title, content)) {
          return null;
        }

        if (title === "Open Items") {
          return (
            <OpenItemsSection
              key={title}
              node={node}
              content={content}
              onSectionsChanged={onSectionsChanged}
            />
          );
        }
        if (title === "Changelog") {
          return <ChangelogSection key={title} content={content} />;
        }
        if (title === "Key Details") {
          return <KeyDetailsSection key={title} content={content} />;
        }
        if (title === "Decisions & Insights") {
          return <DecisionsSection key={title} content={content} />;
        }

        return (
          <GenericSectionCard
            key={title}
            title={title}
            content={content}
            allNodes={allNodes}
            onPick={onPick}
          />
        );
      })}
    </div>
  );
}

export function ContextFileSections({
  content,
  fileName,
  updatedAt,
  allNodes,
  onPick,
}: {
  content: string;
  fileName?: string;
  updatedAt?: string;
  allNodes: WikiNode[];
  onPick: (node: WikiNode) => void;
}) {
  const updatedLabel = formatUpdatedAt(updatedAt);
  const goalNodes = useMemo(() => collectGoalNodes(allNodes), [allNodes]);
  const sections = useMemo(() => {
    const parsed: Record<string, string> = {};
    const parts = content.split(/^## /m).filter(Boolean);
    if (parts.length <= 1 && !content.includes("\n## ")) {
      return null;
    }
    for (const part of parts) {
      const newline = part.indexOf("\n");
      if (newline < 0) continue;
      const title = part.slice(0, newline).trim();
      const body = part.slice(newline + 1).trim();
      if (title) parsed[title] = body;
    }
    return Object.keys(parsed).length ? parsed : null;
  }, [content]);

  if (!sections) {
    return (
      <div className="wiki-entity-sections">
        {updatedLabel ? (
          <div className="wiki-entity-sections__updated">{updatedLabel}</div>
        ) : null}
        <article className="wiki-section-card">
          <div className="wiki-section-card__body">
            <RichSectionText text={content} allNodes={allNodes} onPick={onPick} />
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="wiki-entity-sections">
      {updatedLabel ? (
        <div className="wiki-entity-sections__updated">{updatedLabel}</div>
      ) : null}
      {Object.entries(sections).map(([title, body]) => {
        if (
          fileName === "IDENTITY.md" &&
          title === "Goals" &&
          isIdentitySectionPlaceholder(title, body)
        ) {
          if (!goalNodes.length) return null;
          return (
            <IdentityGoalsSection
              key={title}
              goals={goalNodes}
              onPick={onPick}
            />
          );
        }
        if (isIdentitySectionPlaceholder(title, body)) {
          return null;
        }
        return (
          <GenericSectionCard
            key={title}
            title={title}
            content={body}
            allNodes={allNodes}
            onPick={onPick}
          />
        );
      })}
    </div>
  );
}

export function UpdatedAtBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const label = formatLastUpdated(value ?? null);
  if (!label) return null;
  return <span className={className ?? "wiki-updated-at"}>{label}</span>;
}

/** @deprecated Use WikiTasksView */
export const WikiOpenItemsSection = WikiTasksView;
