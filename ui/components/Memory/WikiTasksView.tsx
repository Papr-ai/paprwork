import React, { memo, useCallback, useMemo, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import type { WikiNode } from "../../types/wiki";
import { wikiTypeMeta } from "../../types/wiki";
import {
  collectOpenItemsAcrossEntities,
  groupOpenItemsByCategory,
  OPEN_ITEM_CATEGORY_LABELS,
  OPEN_ITEM_CATEGORY_ORDER,
  type AggregatedOpenItem,
  type OpenItemCategory,
} from "../../utils/wikiSectionUtils";
import "./WikiTasksView.css";

type TaskFilter = OpenItemCategory | "all";

const FILTER_OPTIONS: { id: TaskFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "user", label: "Your work" },
  { id: "agent", label: "Agent" },
  { id: "papr", label: "Papr" },
];

function categoryDescription(category: OpenItemCategory): string {
  switch (category) {
    case "user":
      return "Meetings, reviews, and follow-ups that need you.";
    case "agent":
      return "Fixes and improvements Papr's agent is tracking.";
    case "papr":
      return "Setup, integrations, and workspace configuration.";
    default:
      return "Items waiting for Wiki Writer to categorize.";
  }
}

function itemKey(item: AggregatedOpenItem): string {
  return `${item.entityId}:${item.fileIndex}`;
}

const TaskRow = memo(function TaskRow({
  item,
  busy,
  onToggle,
  onPick,
  showCategory,
}: {
  item: AggregatedOpenItem;
  busy: boolean;
  onToggle: (key: string) => void;
  onPick: (node: WikiNode) => void;
  showCategory: boolean;
}) {
  const meta = wikiTypeMeta(item.entityType);
  const key = itemKey(item);
  return (
    <li
      className={`tasks-row tasks-row--${item.category}${busy ? " tasks-row--busy" : ""}`}
    >
      <button
        type="button"
        className="tasks-row__check"
        aria-label={`Mark "${item.text}" complete`}
        disabled={busy}
        onClick={() => onToggle(key)}
      >
        <span className="tasks-row__check-ring" aria-hidden />
      </button>
      <div className="tasks-row__body">
        <p className="tasks-row__title" title={item.text}>
          {item.text}
        </p>
        <div className="tasks-row__meta">
          {showCategory && item.category !== "uncategorized" ? (
            <span
              className={`tasks-row__category tasks-row__category--${item.category}`}
            >
              {OPEN_ITEM_CATEGORY_LABELS[item.category]}
            </span>
          ) : null}
          <button
            type="button"
            className="tasks-row__entity"
            onClick={() => onPick(item.entityRef)}
            style={{ "--entity-color": meta.color } as React.CSSProperties}
          >
            {item.entityLabel}
          </button>
        </div>
      </div>
    </li>
  );
});

export function WikiTasksView({
  nodes,
  onPick,
  onChanged,
}: {
  nodes: WikiNode[];
  onPick: (node: WikiNode) => void;
  onChanged?: () => void;
}) {
  const allItems = useMemo(
    () => collectOpenItemsAcrossEntities(nodes),
    [nodes],
  );
  const grouped = useMemo(
    () => groupOpenItemsByCategory(allItems),
    [allItems],
  );
  const itemByKey = useMemo(() => {
    const map = new Map<string, AggregatedOpenItem>();
    for (const item of allItems) {
      map.set(itemKey(item), item);
    }
    return map;
  }, [allItems]);

  const [filter, setFilter] = useState<TaskFilter>("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleItem = useCallback(
    async (item: AggregatedOpenItem) => {
      const key = itemKey(item);
      setBusyKey(key);
      setError(null);
      try {
        const response = await gateway.send(
          "memory:wiki-toggle-open-item",
          {
            type: item.entityType,
            id: item.entityId,
            itemIndex: item.fileIndex,
            completed: true,
          },
          { timeoutMs: 15_000 },
        );
        if (!response.success) {
          throw new Error(response.error ?? "Could not update item");
        }
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update item");
      } finally {
        setBusyKey(null);
      }
    },
    [onChanged],
  );

  const handleToggle = useCallback(
    (key: string) => {
      const item = itemByKey.get(key);
      if (item) void toggleItem(item);
    },
    [itemByKey, toggleItem],
  );

  const filterCounts = useMemo(
    () => ({
      all: allItems.length,
      user: grouped.user.length,
      agent: grouped.agent.length,
      papr: grouped.papr.length,
      uncategorized: grouped.uncategorized.length,
    }),
    [allItems.length, grouped],
  );

  const visibleSections = useMemo(() => {
    if (filter === "all") {
      return OPEN_ITEM_CATEGORY_ORDER.filter(
        (category) => grouped[category].length > 0,
      ).map((category) => ({
        category,
        items: grouped[category],
      }));
    }
    return grouped[filter].length > 0
      ? [{ category: filter, items: grouped[filter] }]
      : [];
  }, [filter, grouped]);

  const activeFilterLabel =
    FILTER_OPTIONS.find((option) => option.id === filter)?.label ?? "All";

  return (
    <div className="tasks-view">
      <header className="tasks-view__header">
        <div className="tasks-view__intro">
          <h1>Tasks</h1>
          <p>
            {allItems.length > 0
              ? `${allItems.length} open across your workspace`
              : "Follow-ups from Sleep and Wiki Writer land here."}
          </p>
        </div>
        <div
          className="tasks-view__filters"
          role="tablist"
          aria-label="Filter tasks"
        >
          {FILTER_OPTIONS.map((option) => {
            const count =
              option.id === "all"
                ? filterCounts.all
                : filterCounts[option.id];
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={filter === option.id}
                className={`tasks-view__filter${filter === option.id ? " tasks-view__filter--active" : ""}`}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                <span className="tasks-view__filter-count">{count}</span>
              </button>
            );
          })}
          {filterCounts.uncategorized > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={filter === "uncategorized"}
              className={`tasks-view__filter${filter === "uncategorized" ? " tasks-view__filter--active" : ""}`}
              onClick={() => setFilter("uncategorized")}
            >
              Uncategorized
              <span className="tasks-view__filter-count">
                {filterCounts.uncategorized}
              </span>
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="tasks-view__error" role="alert">
          {error}
        </p>
      ) : null}

      {allItems.length === 0 ? (
        <div className="tasks-view__empty">
          <div className="tasks-view__empty-icon" aria-hidden>
            ✓
          </div>
          <h2>All clear</h2>
          <p>
            When conversations surface follow-ups, Wiki Writer adds them to
            entity pages with <code>[user]</code>, <code>[agent]</code>, or{" "}
            <code>[papr]</code> tags.
          </p>
        </div>
      ) : visibleSections.length === 0 ? (
        <div className="tasks-view__empty tasks-view__empty--filter">
          <h2>No {activeFilterLabel.toLowerCase()} tasks</h2>
          <p>{categoryDescription(filter as OpenItemCategory)}</p>
          <button
            type="button"
            className="tasks-view__empty-action"
            onClick={() => setFilter("all")}
          >
            Show all tasks
          </button>
        </div>
      ) : (
        <div className="tasks-view__sections">
          {visibleSections.map(({ category, items }) => (
            <section key={category} className="tasks-section">
              {filter === "all" ? (
                <header className="tasks-section__head">
                  <h2>{OPEN_ITEM_CATEGORY_LABELS[category]}</h2>
                  <p>{categoryDescription(category)}</p>
                </header>
              ) : null}
              <ul className="tasks-list">
                {items.map((item) => {
                  const key = itemKey(item);
                  return (
                    <TaskRow
                      key={key}
                      item={item}
                      busy={busyKey === key}
                      onToggle={handleToggle}
                      onPick={onPick}
                      showCategory={filter === "all"}
                    />
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
