import React from "react";
import type { PaprCloudStatusDotVariant } from "../../utils/cloudMemoryStatus";
import "./avatarStatusDot.css";

export interface AvatarStatusDotProps {
  variant: PaprCloudStatusDotVariant;
  /** Slightly larger ring for profile header photos (~44px). */
  size?: "md" | "lg";
  title?: string;
}

export function AvatarStatusDot({
  variant,
  size = "md",
  title,
}: AvatarStatusDotProps) {
  return (
    <span
      className={`avatar-status-dot avatar-status-dot--${variant}${
        size === "lg" ? " avatar-status-dot--lg" : ""
      }`}
      aria-hidden={title ? undefined : true}
      title={title}
    />
  );
}
