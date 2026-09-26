/**
 * Official provider brand marks used across Profile + onboarding.
 */

import openaiSvg from "../../assets/brand/openai-logomark.svg?raw";
import anthropicSvg from "../../assets/brand/anthropic-logomark.svg?raw";
import "./ProviderBrandIcon.css";

export type ProviderBrandId = "openai" | "anthropic";

/**
 * Inlined, not fetched from /images/. On first launch the UI can render
 * before the gateway serves static files, and a failed <img> request never
 * retries — the onboarding cards showed broken icons until a relaunch.
 */
const toDataUri = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const PROVIDER_LOGOS: Record<ProviderBrandId, { src: string; alt: string }> = {
  openai: {
    src: toDataUri(openaiSvg),
    alt: "OpenAI",
  },
  anthropic: {
    src: toDataUri(anthropicSvg),
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
