import type { ReactNode } from "react";
import type { JobType } from "../hooks/useJobs";

interface JobTypeIconProps {
  type: JobType | string;
  size?: number;
  className?: string;
}

export function JobTypeIcon({ type, size = 14, className }: JobTypeIconProps): ReactNode {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    className,
    "aria-hidden": true as const,
  };

  switch (type) {
    case "python":
      return (
        <svg {...props}>
          <path
            d="M8 4h8a2 2 0 012 2v4H6V6a2 2 0 012-2zm-2 8h16v6a2 2 0 01-2 2H8a2 2 0 01-2-2v-6z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="10" cy="7" r="1" fill="currentColor" />
          <circle cx="14" cy="17" r="1" fill="currentColor" />
        </svg>
      );
    case "node":
      return (
        <svg {...props}>
          <path
            d="M12 3l7 4v10l-7 4-7-4V7l7-4z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M12 11v6M9 13.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "agent":
    case "subagent":
      return (
        <svg {...props}>
          <path
            d="M12 3a4 4 0 014 4v1h1a3 3 0 013 3v5a3 3 0 01-3 3H8a3 3 0 01-3-3v-5a3 3 0 013-3h1V7a4 4 0 014-4z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="10" cy="13" r="1" fill="currentColor" />
          <circle cx="14" cy="13" r="1" fill="currentColor" />
          <path d="M10 16.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "bash":
    case "shell":
      return (
        <svg {...props}>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 10l2.5 2.5L7 15M12 15h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "swift":
      return (
        <svg {...props}>
          <path
            d="M5 17c3-6 6-9 14-12-1 6-3 10-8 13-2 1-4 1-6-1z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
}
