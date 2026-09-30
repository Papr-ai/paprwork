/**
 * Display metadata for Platform Connections connect modal.
 *
 * Built-in social platforms have fixed branding; agent/user-registered sites
 * use ids like `site-mail-google-com` and must never crash the UI when looked up.
 */

export const BUILTIN_PLATFORM_IDS = [
  "linkedin",
  "instagram",
  "reddit",
  "facebook",
  "tiktok",
  "twitter",
  "telegram",
] as const;

export type BuiltinPlatformId = (typeof BUILTIN_PLATFORM_IDS)[number];

export interface PlatformConnectDisplay {
  name: string;
  color: string;
  description: string;
  isBuiltin: boolean;
}

const BUILTIN_PLATFORM_INFO: Record<
  BuiltinPlatformId,
  Omit<PlatformConnectDisplay, "isBuiltin">
> = {
  linkedin: {
    name: "LinkedIn",
    color: "#0A66C2",
    description: "Connect to access your messages, connections, and profile",
  },
  instagram: {
    name: "Instagram",
    color: "#E4405F",
    description: "Connect to access your DMs, posts, and followers",
  },
  reddit: {
    name: "Reddit",
    color: "#FF4500",
    description: "Connect to access your subreddits, messages, and posts",
  },
  facebook: {
    name: "Facebook",
    color: "#1877F2",
    description: "Connect to access your messages, pages, and profile",
  },
  tiktok: {
    name: "TikTok",
    color: "#000000",
    description: "Connect to access your videos, messages, and followers",
  },
  twitter: {
    name: "X / Twitter",
    color: "#000000",
    description: "Connect to access your tweets, DMs, and followers",
  },
  telegram: {
    name: "Telegram",
    color: "#0088CC",
    description: "Connect to access your chats, channels, and groups",
  },
};

const CUSTOM_SITE_DEFAULT_COLOR = "#6366F1";

export function isBuiltinPlatformId(
  platformId: string,
): platformId is BuiltinPlatformId {
  return (BUILTIN_PLATFORM_IDS as readonly string[]).includes(platformId);
}

/** Reverse of gateway `slugifyPlatformId` (site-mail-google-com → mail.google.com). */
export function decodeCustomSiteHostname(platformId: string): string | null {
  if (!platformId.startsWith("site-")) {
    return null;
  }
  const slug = platformId.slice("site-".length).trim();
  if (!slug) {
    return null;
  }
  return slug.replace(/-/g, ".");
}

export function resolvePlatformConnectDisplay(
  platformId: string,
): PlatformConnectDisplay {
  const trimmed = platformId.trim();
  if (isBuiltinPlatformId(trimmed)) {
    const info = BUILTIN_PLATFORM_INFO[trimmed];
    return { ...info, isBuiltin: true };
  }

  const hostname = decodeCustomSiteHostname(trimmed);
  const name = hostname ?? trimmed;
  return {
    name,
    color: CUSTOM_SITE_DEFAULT_COLOR,
    description: hostname
      ? `Connect to sign in to ${hostname} in Chrome`
      : "Connect to sign in to this site in Chrome",
    isBuiltin: false,
  };
}
