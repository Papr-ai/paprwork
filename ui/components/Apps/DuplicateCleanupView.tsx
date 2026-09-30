/**
 * One screen to resolve every near-duplicate cluster. Nothing is deleted:
 * the copies you don't keep move to Archived with their data intact.
 */
import { useMemo, useState } from "react";
import type { Artifact } from "../../stores/artifactsStore";

interface DuplicateCleanupViewProps {
  groups: Artifact[][];
  formatWhen: (app: Artifact) => string;
  onCancel: () => void;
  onArchive: (ids: string[]) => Promise<void>;
}

export function DuplicateCleanupView({
  groups,
  formatWhen,
  onCancel,
  onArchive,
}: DuplicateCleanupViewProps) {
  // Default keeper: the most recently used copy (groups arrive sorted that way).
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const keeperOf = (i: number) => keep[i] ?? groups[i][0].id;

  const toArchive = useMemo(
    () =>
      groups.flatMap((g, i) =>
        g.filter((a) => a.id !== (keep[i] ?? g[0].id)).map((a) => a.id),
      ),
    [groups, keep],
  );

  const archive = async () => {
    setBusy(true);
    try {
      await onArchive(toArchive);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="apps-cleanup">
      <button type="button" className="apps-cleanup__back" onClick={onCancel}>
        ← Recent
      </button>
      <h1 className="apps-view__page-title">Clean up duplicates</h1>
      <p className="apps-view__page-subtitle">
        These look like copies of the same app. Pick the one to keep — the rest
        move to Archived with their data, and you can restore them any time.
      </p>
      <div className="apps-cleanup__groups">
        {groups.map((group, i) => (
          <section key={group[0].id} className="apps-cleanup__group">
            <header className="apps-cleanup__group-head">
              <strong>{group[0].title}</strong>
              <span>{group.length} copies</span>
            </header>
            {group.map((app) => {
              const kept = keeperOf(i) === app.id;
              return (
                <label
                  key={app.id}
                  className={`apps-cleanup__row${kept ? " apps-cleanup__row--kept" : ""}`}
                >
                  <input
                    type="radio"
                    name={`dup-${i}`}
                    checked={kept}
                    onChange={() => setKeep((k) => ({ ...k, [i]: app.id }))}
                  />
                  <span className="apps-cleanup__title">{app.title}</span>
                  <span className="apps-cleanup__when">{formatWhen(app)}</span>
                  <span className="apps-cleanup__tag">
                    {kept ? "Keep" : "Archive"}
                  </span>
                </label>
              );
            })}
          </section>
        ))}
      </div>
      <div className="apps-cleanup__footer">
        <button
          type="button"
          className="apps-view__secondary-btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="apps-view__create-btn"
          onClick={() => void archive()}
          disabled={busy || toArchive.length === 0}
        >
          {busy
            ? "Archiving…"
            : `Archive ${toArchive.length} ${toArchive.length === 1 ? "copy" : "copies"}`}
        </button>
      </div>
    </div>
  );
}
