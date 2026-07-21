import React from "react";

interface MemoryIconProps {
  size?: number;
  className?: string;
}

/** Infinity / wiki mark for Memory navigation */
export function MemoryIcon({ size = 20, className }: MemoryIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M6.5 10.5c-1.8 0-3.2 1.4-3.2 3.2s1.4 3.3 3.2 3.3c1.5 0 2.6-.9 4.3-3.2 1.7-2.3 2.8-3.2 4.3-3.2 1.8 0 3.2 1.4 3.2 3.2s-1.4 3.3-3.2 3.3c-1.5 0-2.6-.9-4.3-3.2C9.1 11.4 8 10.5 6.5 10.5z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
