/** Rail icons — 24px grid, 1.7 stroke, currentColor. One concrete metaphor per destination. */
import type { ReactNode } from "react";

function Icon({ children, small = false }: { children: ReactNode; small?: boolean }) {
  const size = small ? 14 : 20;
  return (
    <svg
      className="rail-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const RailIcons = {
  plus: () => (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  search: () => (
    <Icon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </Icon>
  ),
  chats: () => (
    <Icon>
      <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z" />
    </Icon>
  ),
  apps: () => (
    <Icon>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" />
    </Icon>
  ),
  docs: () => (
    <Icon>
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
      <path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" />
    </Icon>
  ),
  start: () => (
    <Icon>
      <path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z" />
      <path d="M18.5 16v4M16.5 18h4" />
    </Icon>
  ),
  settings: () => (
    <Icon small>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
    </Icon>
  ),
  person: () => (
    <Icon small>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c1-3.6 3.6-5.5 7-5.5s6 1.9 7 5.5" />
    </Icon>
  ),
  pin: () => (
    <Icon small>
      <path d="M9 4h6l-1 5 3 3v1.5H7V12l3-3z" />
      <path d="M12 13.5V20" />
    </Icon>
  ),
  arrow: () => (
    <Icon small>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  ),
  close: () => (
    <Icon small>
      <path d="M7 7l10 10M17 7 7 17" />
    </Icon>
  ),
};
