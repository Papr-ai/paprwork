/**
 * Official provider brand marks used across Profile + onboarding.
 */

import React from "react";
import "./ProviderBrandIcon.css";

export type ProviderBrandId = "openai" | "anthropic";

const PROVIDER_LOGOS: Record<ProviderBrandId, { src: string; alt: string }> = {
  openai: {
    src: "/images/openai-logomark.svg",
    alt: "OpenAI",
  },
  anthropic: {
    src: "/images/anthropic-logomark.svg",
    alt: "Anthropic",
  },
};

interface ProviderBrandIconProps {
  providerId: ProviderBrandId;
  size?: number;
  className?: string;
  /** When true, icon sits on a light surface — skip dark-mode invert for OpenAI */
  onLightSurface?: boolean;
}

export function ProviderBrandIcon({
  providerId,
  size = 16,
  className = "",
  onLightSurface = false,
}: ProviderBrandIconProps) {
  const logo = PROVIDER_LOGOS[providerId];
  return (
    <img
      src={logo.src}
      alt={logo.alt}
      width={size}
      height={size}
      className={`provider-brand-icon provider-brand-icon--${providerId}${onLightSurface ? " provider-brand-icon--light-surface" : ""}${className ? ` ${className}` : ""}`}
      draggable={false}
    />
  );
}
