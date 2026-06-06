import type { ReactNode } from "react";

interface AppIconOptions {
  size?: number;
  className?: string;
}

function isImageIcon(icon: string): boolean {
  return icon.startsWith("data:image/") || icon.startsWith("http");
}

export function DefaultAppIcon({ size = 20, className }: AppIconOptions = {}): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function renderAppIcon(icon: string | undefined, options: AppIconOptions = {}): ReactNode {
  const { size = 20, className } = options;

  if (!icon?.trim()) {
    return <DefaultAppIcon size={size} className={className} />;
  }

  const trimmed = icon.trim();

  if (isImageIcon(trimmed)) {
    return (
      <img
        className={className}
        src={trimmed}
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{ objectFit: "contain", borderRadius: 4 }}
      />
    );
  }

  if (trimmed.startsWith("<")) {
    return (
      <span
        className={className}
        dangerouslySetInnerHTML={{ __html: trimmed }}
      />
    );
  }

  return <DefaultAppIcon size={size} className={className} />;
}
