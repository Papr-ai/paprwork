/**
 * Shared sidebar panel toggle button (ChatGPT-style)
 */

import { SidebarToggleIcon } from "./SidebarToggleIcon";
import "./SidebarToggleButton.css";

interface SidebarToggleButtonProps {
  onClick: () => void;
  className?: string;
  ariaLabel: string;
}

export function SidebarToggleButton({
  onClick,
  className = "",
  ariaLabel,
}: SidebarToggleButtonProps) {
  return (
    <button
      type="button"
      className={`sidebar-toggle-btn ${className}`.trim()}
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <SidebarToggleIcon size={18} />
    </button>
  );
}
