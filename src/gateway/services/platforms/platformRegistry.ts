/**
 * Platform Registry - Configuration for supported social platforms
 *
 * Defines login URLs, required cookies, refresh intervals, rate limits,
 * and key naming for each platform that can be connected via the
 * Connected Platforms feature.
 */

/**
 * Rate limits for platform actions based on best practices.
 * These are conservative defaults to avoid account restrictions.
 * The agent can override these if the use case warrants it.
 */
export interface PlatformRateLimits {
  /** Max profile/page views per day */
  dailyViews: number;
  /** Max outgoing messages/DMs per day */
  dailyMessages: number;
  /** Max connection/follow requests per day */
  dailyConnections: number;
  /** Max posts/comments per day */
  dailyPosts: number;
  /** Max actions per hour (any action type) */
  hourlyActions: number;
  /** Minimum delay between actions in ms (human-like pacing) */
  minActionDelayMs: number;
  /** Maximum delay between actions in ms (randomize within range) */
  maxActionDelayMs: number;
  /** Notes explaining the limits */
  notes: string;
}

export interface PlatformConfig {
  /** Unique identifier: "linkedin", "instagram", etc. */
  id: string;
  /** Display name: "LinkedIn" */
  name: string;
  /** URL to open for login */
  loginUrl: string;
  /** URL to navigate to for session refresh (logged-in home page) */
  homeUrl: string;
  /** Pattern that indicates successful login (user is on authenticated page) */
  successUrlPattern: RegExp;
  /** Cookie names required for API access */
  requiredCookies: string[];
  /** Prefix for keychain storage: "LINKEDIN" -> LINKEDIN_LI_AT */
  keyPrefix: string;
  /** How often to refresh cookies in background (ms) */
  refreshIntervalMs: number;
  /** Typical session duration before expiration (days) */
  sessionDurationDays: number;
  /** Domain to extract cookies from */
  cookieDomain: string;
  /** Per-cookie Playwright domain when rebuilding from keychain (host_key from Chrome) */
  cookieDomainOverrides?: Record<string, string>;
  /** Extra session cookies to capture from Chrome (not required for connect status) */
  optionalCookies?: string[];
  /** Landing URL before homeUrl during prepare_browser (avoids redirect loops) */
  prepareNavigationUrl?: string;
  /** Optional: Additional domains to check for cookies */
  additionalDomains?: string[];
  /** Whether this platform rotates tokens (needs more frequent refresh) */
  rotatesTokens: boolean;
  /** Notes for the user about this platform */
  notes?: string;
  /** Rate limits for safe automation (agent uses these by default) */
  rateLimits: PlatformRateLimits;
}

export type PlatformId =
  // Social
  | "linkedin"
  | "instagram"
  | "reddit"
  | "facebook"
  | "tiktok"
  | "twitter"
  | "telegram";

export const PLATFORM_REGISTRY: Record<PlatformId, PlatformConfig> = {
  linkedin: {
    id: "linkedin",
    name: "LinkedIn",
    loginUrl: "https://www.linkedin.com/login",
    homeUrl: "https://www.linkedin.com/feed/",
    successUrlPattern: /linkedin\.com\/(feed|in\/|mynetwork|messaging)/,
    requiredCookies: ["li_at", "JSESSIONID"],
    optionalCookies: ["bcookie", "bscookie", "liap", "lang", "lidc"],
    keyPrefix: "LINKEDIN",
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes (LinkedIn rotates tokens)
    sessionDurationDays: 45,
    cookieDomain: ".linkedin.com",
    cookieDomainOverrides: {
      li_at: ".linkedin.com",
      JSESSIONID: ".www.linkedin.com",
    },
    prepareNavigationUrl: "https://www.linkedin.com/",
    rotatesTokens: true,
    notes:
      "LinkedIn rotates session tokens frequently. The session keeper refreshes every 5 minutes to capture new tokens.",
    rateLimits: {
      dailyViews: 80, // LinkedIn is VERY strict - 100 can trigger warnings
      dailyMessages: 50, // InMail/message limits
      dailyConnections: 25, // Connection requests - very aggressive detection
      dailyPosts: 3, // Posts/comments
      hourlyActions: 20, // Total actions per hour
      minActionDelayMs: 3000, // 3-8 seconds between actions (human-like)
      maxActionDelayMs: 8000,
      notes:
        "LinkedIn has aggressive automation detection. Stay well under limits. Warm up new accounts slowly (start at 50% of limits for first 2 weeks).",
    },
  },
  instagram: {
    id: "instagram",
    name: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login/",
    homeUrl: "https://www.instagram.com/",
    successUrlPattern: /instagram\.com\/?($|\/[^accounts])/,
    requiredCookies: ["sessionid", "csrftoken"],
    keyPrefix: "INSTAGRAM",
    refreshIntervalMs: 30 * 60 * 1000, // 30 minutes
    sessionDurationDays: 90,
    cookieDomain: ".instagram.com",
    rotatesTokens: false,
    rateLimits: {
      dailyViews: 200, // Profile views
      dailyMessages: 50, // DMs - Instagram is strict on cold outreach
      dailyConnections: 60, // Follow requests
      dailyPosts: 10, // Posts/stories/comments
      hourlyActions: 30, // Total actions per hour
      minActionDelayMs: 2000, // 2-5 seconds between actions
      maxActionDelayMs: 5000,
      notes:
        "Instagram action blocks last 24-48 hours. DM limits are stricter for accounts you don't follow. Spread actions throughout the day.",
    },
  },
  reddit: {
    id: "reddit",
    name: "Reddit",
    loginUrl: "https://www.reddit.com/login/",
    homeUrl: "https://www.reddit.com/",
    successUrlPattern: /reddit\.com\/?($|\/r\/|\/user\/)/,
    requiredCookies: ["reddit_session", "token_v2"],
    keyPrefix: "REDDIT",
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
    sessionDurationDays: 30,
    cookieDomain: ".reddit.com",
    rotatesTokens: false,
    rateLimits: {
      dailyViews: 500, // Reddit is relatively lenient on viewing
      dailyMessages: 30, // Chat/DMs - stricter for new accounts
      dailyConnections: 100, // Following users
      dailyPosts: 10, // Posts/comments - subreddit-specific limits also apply
      hourlyActions: 60, // Total actions per hour
      minActionDelayMs: 1000, // 1-3 seconds between actions
      maxActionDelayMs: 3000,
      notes:
        "Subreddits have their own posting limits (often 1 post per 10 minutes). Account age and karma affect limits. New accounts are very restricted.",
    },
  },
  facebook: {
    id: "facebook",
    name: "Facebook",
    loginUrl: "https://www.facebook.com/login/",
    homeUrl: "https://www.facebook.com/",
    successUrlPattern: /facebook\.com\/?($|\/[^login])/,
    requiredCookies: ["c_user", "xs"],
    keyPrefix: "FACEBOOK",
    refreshIntervalMs: 30 * 60 * 1000, // 30 minutes
    sessionDurationDays: 90,
    cookieDomain: ".facebook.com",
    rotatesTokens: false,
    rateLimits: {
      dailyViews: 200, // Profile views
      dailyMessages: 50, // Messenger - stricter for non-friends
      dailyConnections: 50, // Friend requests - Facebook is strict
      dailyPosts: 10, // Posts/comments
      hourlyActions: 30, // Total actions per hour
      minActionDelayMs: 2000, // 2-6 seconds between actions
      maxActionDelayMs: 6000,
      notes:
        "Facebook has sophisticated automation detection. Friend request limits are very strict. Messenger limits are stricter for people outside your network.",
    },
  },
  tiktok: {
    id: "tiktok",
    name: "TikTok",
    loginUrl: "https://www.tiktok.com/login",
    homeUrl: "https://www.tiktok.com/foryou",
    successUrlPattern: /tiktok\.com\/(foryou|following|@)/,
    requiredCookies: ["sessionid", "sid_tt"],
    keyPrefix: "TIKTOK",
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
    sessionDurationDays: 30,
    cookieDomain: ".tiktok.com",
    rotatesTokens: false,
    rateLimits: {
      dailyViews: 300, // Video/profile views
      dailyMessages: 30, // DMs - limited feature
      dailyConnections: 200, // Follow requests - TikTok is more lenient
      dailyPosts: 5, // Videos/comments
      hourlyActions: 50, // Total actions per hour
      minActionDelayMs: 1500, // 1.5-4 seconds between actions
      maxActionDelayMs: 4000,
      notes:
        "TikTok has shadowban detection. Engagement must look organic. Avoid following/unfollowing same accounts repeatedly.",
    },
  },
  twitter: {
    id: "twitter",
    name: "X / Twitter",
    loginUrl: "https://x.com/i/flow/login",
    homeUrl: "https://x.com/home",
    successUrlPattern: /x\.com\/(home|explore|notifications)/,
    requiredCookies: ["auth_token", "ct0"],
    keyPrefix: "TWITTER",
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
    sessionDurationDays: 365,
    cookieDomain: ".x.com",
    additionalDomains: [".twitter.com"],
    rotatesTokens: false,
    notes:
      "For X/Twitter automation, the `bird` CLI tool is recommended as it handles cookie extraction automatically from your browser.",
    rateLimits: {
      dailyViews: 500, // Tweet/profile views - API rate limits are stricter
      dailyMessages: 100, // DMs - relatively lenient
      dailyConnections: 100, // Follow requests - can get restricted
      dailyPosts: 50, // Tweets/replies - avoid duplicates
      hourlyActions: 50, // Total actions per hour
      minActionDelayMs: 1000, // 1-3 seconds between actions
      maxActionDelayMs: 3000,
      notes:
        "X has daily tweet read limits (varies by subscription). Follow churn (follow then unfollow) triggers restrictions. Duplicate content is penalized.",
    },
  },
  telegram: {
    id: "telegram",
    name: "Telegram",
    loginUrl: "https://web.telegram.org/a/",
    homeUrl: "https://web.telegram.org/a/",
    successUrlPattern: /web\.telegram\.org\/a\/#?(-?\d+|@\w+)?$/,
    requiredCookies: ["stel_ssid", "stel_token"],
    keyPrefix: "TELEGRAM",
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
    sessionDurationDays: 180, // Telegram sessions last long
    cookieDomain: ".telegram.org",
    rotatesTokens: false,
    notes:
      "Telegram Web requires phone number + code verification. Sessions are tied to device. Use the 'A' version (web.telegram.org/a/) for better automation support.",
    rateLimits: {
      dailyViews: 500, // Channel/chat views
      dailyMessages: 200, // Messages - Telegram is lenient for messages
      dailyConnections: 50, // New chats/group joins - stricter
      dailyPosts: 100, // Channel posts/group messages
      hourlyActions: 100, // Total actions per hour
      minActionDelayMs: 500, // 0.5-2 seconds between actions
      maxActionDelayMs: 2000,
      notes:
        "Telegram has flood wait limits that auto-adjust. If you hit limits, you'll get temporary blocks (seconds to hours). Avoid adding strangers to groups en masse.",
    },
  },

};

/**
 * Get platform config by ID
 */
export function getPlatformConfig(
  platformId: string,
): PlatformConfig | undefined {
  return PLATFORM_REGISTRY[platformId as PlatformId];
}

/**
 * Get all platform IDs
 */
export function getAllPlatformIds(): PlatformId[] {
  return Object.keys(PLATFORM_REGISTRY) as PlatformId[];
}

/**
 * Get the keychain key name for a platform cookie
 * e.g., ("linkedin", "li_at") -> "LINKEDIN_LI_AT"
 */
export function getPlatformKeyName(
  platformId: string,
  cookieName: string,
): string {
  const config = getPlatformConfig(platformId);
  if (!config) {
    throw new Error(`Unknown platform: ${platformId}`);
  }
  return `${config.keyPrefix}_${cookieName.toUpperCase()}`;
}

/**
 * Get all keychain key names for a platform
 * e.g., "linkedin" -> ["LINKEDIN_LI_AT", "LINKEDIN_JSESSIONID"]
 */
export function getAllPlatformKeyNames(platformId: string): string[] {
  const config = getPlatformConfig(platformId);
  if (!config) {
    throw new Error(`Unknown platform: ${platformId}`);
  }
  return config.requiredCookies.map((cookie) =>
    getPlatformKeyName(platformId, cookie),
  );
}

/**
 * Get rate limits for a platform
 */
export function getPlatformRateLimits(
  platformId: string,
): PlatformRateLimits | undefined {
  const config = getPlatformConfig(platformId);
  return config?.rateLimits;
}

/**
 * Get a human-readable summary of platform rate limits for agent context
 */
export function getRateLimitsSummary(): string {
  const lines: string[] = ["Platform Rate Limits (defaults - agent can override if needed):"];
  lines.push("");
  
  for (const [id, config] of Object.entries(PLATFORM_REGISTRY)) {
    const r = config.rateLimits;
    lines.push(`**${config.name}** (${id}):`);
    lines.push(`  - Views: ${r.dailyViews}/day | Messages: ${r.dailyMessages}/day | Connections: ${r.dailyConnections}/day`);
    lines.push(`  - Posts: ${r.dailyPosts}/day | Hourly cap: ${r.hourlyActions}/hr`);
    lines.push(`  - Pace: ${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s delay between actions`);
    lines.push(`  - Note: ${r.notes}`);
    lines.push("");
  }
  
  return lines.join("\n");
}
