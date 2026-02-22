/**
 * Papr Logo Icon - Draw animation for exploring card
 * Draws from bottom up, dotted stroke, black/white via CSS var
 */

import React from "react";
import "./PaprLogoIcon.css";

/** Path reversed so draw starts at bottom and goes up */
const PATH_D =
  "M27.9998 101.5C51.9998 65 40.2693 -8.94844 83.6804 8.27816C115.18 20.7781 99.2884 75.0861 43.4008 60.5002C6.99988 51 -11.5 158 27.9998 101.5Z";

export const PaprLogoIcon: React.FC<{ className?: string }> = ({
  className = "",
}) => (
  <span
    className={`papr-logo-icon ${className}`}
    aria-hidden="true"
    title="Papr"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 105 124"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="papr-logo-icon-svg"
    >
      <path
        d={PATH_D}
        stroke="var(--text-color, #1D1D1F)"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="3 12"
        className="papr-logo-icon-path"
      />
    </svg>
  </span>
);
