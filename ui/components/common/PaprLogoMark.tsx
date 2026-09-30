import { useId } from "react";
import "./PaprLogoMark.css";

const PATH_D =
  "M27.9998 101.5C51.9998 65 40.2693 -8.94844 83.6804 8.27816C115.18 20.7781 99.2884 75.0861 43.4008 60.5002C6.99988 51 -11.5 158 27.9998 101.5Z";

interface PaprLogoMarkProps {
  size?: number;
  className?: string;
}

export function PaprLogoMark({ size = 12, className = "" }: PaprLogoMarkProps) {
  const gradientId = useId();

  return (
    <span className={`papr-logo-mark ${className}`.trim()} aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 105 124"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id={gradientId}
            x1="17.2207"
            y1="89.4214"
            x2="68.8959"
            y2="35.8394"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#0060E0" />
            <stop offset="0.6" stopColor="#00ACFA" />
            <stop offset="1" stopColor="#0BCDFF" />
          </linearGradient>
        </defs>
        <path
          d={PATH_D}
          stroke={`url(#${gradientId})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
