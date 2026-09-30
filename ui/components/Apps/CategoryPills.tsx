/**
 * Category filter row ("All · Sales · Research · …") above an apps grid.
 * Only shows categories that have at least one of the given items, and hides
 * itself when there's too little to filter.
 */
import { useMemo } from "react";
import "./CategoryPills.css";

const MIN_ITEMS = 6;
const MIN_CATEGORIES = 2;
export const OTHER = "Other";

export function CategoryPills({
  keys,
  byKey,
  order,
  value,
  onChange,
}: {
  keys: string[];
  byKey: Record<string, string | null>;
  /** Live category names in display order. */
  order: string[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of keys) {
      if (!(k in byKey)) continue;
      const c = byKey[k] ?? OTHER;
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [keys, byKey]);

  const pills = [...order.filter((c) => counts.has(c)), ...(counts.has(OTHER) ? [OTHER] : [])];
  if (keys.length < MIN_ITEMS || pills.filter((p) => p !== OTHER).length < MIN_CATEGORIES) {
    return null;
  }

  return (
    <div className="category-pills" role="tablist" aria-label="Filter by category">
      <button
        type="button"
        role="tab"
        aria-selected={value === null}
        className={`category-pills__pill${value === null ? " is-active" : ""}`}
        onClick={() => onChange(null)}
      >
        All
      </button>
      {pills.map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={value === p}
          className={`category-pills__pill${value === p ? " is-active" : ""}`}
          onClick={() => onChange(value === p ? null : p)}
        >
          {p}
          <span className="category-pills__count">{counts.get(p)}</span>
        </button>
      ))}
    </div>
  );
}

/** Filter helper shared by Library and catalog views. */
export function matchesCategory(
  key: string,
  byKey: Record<string, string | null>,
  value: string | null,
): boolean {
  if (value === null) return true;
  if (!(key in byKey)) return false;
  return (byKey[key] ?? OTHER) === value;
}
