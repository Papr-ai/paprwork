/**
 * RailPeek — flyout body for Chats / Apps / Docs: Pinned (favorites) + Recent, full titles
 * wrapping to two lines instead of truncating, and one "See all" action.
 */
import type { ReactNode } from "react";
import { RailIcons } from "./railIcons";

export interface PeekRow {
  id: string;
  title: string;
  sub?: string;
  live?: boolean;
  onOpen: () => void;
  /** Present for favorites — shows an unpin control on hover. */
  onRemove?: () => void;
}

export interface PeekGroup {
  title: string;
  pinned?: boolean;
  rows: PeekRow[];
}

interface RailPeekProps {
  title: string;
  groups: PeekGroup[];
  empty?: ReactNode;
  footer?: { label: string; onClick: () => void };
}

function Row({ row }: { row: PeekRow }) {
  return (
    <div className="rail-peek__row">
      <button type="button" className="rail-peek__open" onClick={row.onOpen} role="menuitem">
        <span className="rail-peek__title">{row.title}</span>
        {row.live ? <i className="rail-peek__live" aria-label="Running" /> : null}
        {row.sub ? <span className="rail-peek__sub">{row.sub}</span> : null}
      </button>
      {row.onRemove ? (
        <button
          type="button"
          className="rail-peek__remove"
          onClick={row.onRemove}
          aria-label={`Remove ${row.title} from favorites`}
          title="Remove from favorites"
        >
          <RailIcons.close />
        </button>
      ) : null}
    </div>
  );
}

export function RailPeek({ title, groups, empty, footer }: RailPeekProps) {
  const visible = groups.filter((g) => g.rows.length > 0);
  return (
    <>
      <header className="rail-peek__header">
        <b>{title}</b>
      </header>
      {visible.length === 0 && empty ? <p className="rail-peek__empty">{empty}</p> : null}
      {visible.map((g) => (
        <div className="rail-peek__group" key={g.title}>
          <h6>
            {g.pinned ? <RailIcons.pin /> : null}
            {g.title}
          </h6>
          {g.rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </div>
      ))}
      {footer ? (
        <footer className="rail-peek__footer">
          <button type="button" onClick={footer.onClick}>
            {footer.label}
            <RailIcons.arrow />
          </button>
        </footer>
      ) : null}
    </>
  );
}

/** Compact relative time: "now", "12m", "3h", "Yesterday", "Mon", "Sep 3". */
export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 48) return "Yesterday";
  const d = new Date(t);
  if (hours < 24 * 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
