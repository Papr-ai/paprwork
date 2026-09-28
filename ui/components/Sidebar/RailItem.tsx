/**
 * RailItem — one rail destination: icon button + instant tooltip, or a hover-intent peek flyout.
 * Peeks open on hover or keyboard focus, so everything stays reachable without a mouse.
 */
import type { ReactNode } from "react";

interface RailItemProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  /** Shortcut hint shown in the tooltip — only for shortcuts that actually exist. */
  shortcut?: string;
  /** Flyout content; replaces the tooltip when present. */
  peek?: ReactNode;
  /** Anchor the peek to the bottom of the item (for items near the bottom of the rail). */
  peekFromBottom?: boolean;
  badge?: boolean;
  variant?: "default" | "agent" | "new";
  testId?: string;
  ariaLabel?: string;
  /** Announces background work (e.g. the agent is working) to assistive tech. */
  busy?: boolean;
}

export function RailItem({
  label,
  icon,
  onClick,
  active = false,
  shortcut,
  peek,
  peekFromBottom = false,
  badge = false,
  variant = "default",
  testId,
  ariaLabel,
  busy,
}: RailItemProps) {
  const classes = ["rail-item", peek ? "rail-item--has-peek" : "", peekFromBottom ? "rail-item--peek-bottom" : ""];
  return (
    <div className={classes.filter(Boolean).join(" ")} data-agent-hover={variant === "agent" ? "" : undefined}>
      <button
        type="button"
        className={`rail-btn rail-btn--${variant}${active ? " is-active" : ""}`}
        onClick={onClick}
        aria-label={ariaLabel ?? label}
        aria-current={active ? "page" : undefined}
        aria-busy={busy || undefined}
        data-testid={testId}
      >
        {icon}
        {badge ? <i className="rail-btn__badge" aria-hidden="true" /> : null}
      </button>
      {peek ? (
        <div className="rail-peek" role="menu" aria-label={label}>
          {peek}
        </div>
      ) : (
        <span className="rail-tip" role="tooltip">
          {label}
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </span>
      )}
    </div>
  );
}
