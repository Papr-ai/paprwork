/**
 * ChatGPT-style sidebar panel toggle icon
 */

interface SidebarToggleIconProps {
  size?: number;
}

export function SidebarToggleIcon({ size = 18 }: SidebarToggleIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M9 3v18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
