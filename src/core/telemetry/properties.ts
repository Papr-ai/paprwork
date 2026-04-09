/**
 * User Properties for Amplitude
 * Persistent user attributes tracked across sessions
 */

export interface AmplitudeUserProperties {
  // Platform Info
  platform: "darwin" | "win32" | "linux";
  app_version: string;
  node_version: string;
  electron_version: string;

  // Installation Info
  first_launch_date?: string;
  days_since_install?: number;

  // Provider Configuration (no keys, just yes/no)
  has_anthropic: boolean;
  has_openai: boolean;
  has_google: boolean;
  has_papr: boolean;

  // Feature Usage Counters
  jobs_created_count: number;
  apps_created_count: number;
  chats_created_count: number;
  plans_created_count: number;

  // Settings
  theme: "light" | "dark" | "system";
  telemetry_enabled: boolean;
  has_default_home_app: boolean;

  // OAuth Status
  has_openai_oauth: boolean;
  has_anthropic_oauth: boolean;
}

/**
 * Create initial user properties from system info
 */
export function createInitialUserProperties(
  appVersion: string,
): Partial<AmplitudeUserProperties> {
  return {
    platform: process.platform as "darwin" | "win32" | "linux",
    app_version: appVersion,
    node_version: process.version,
    electron_version: process.versions.electron,
    first_launch_date: new Date().toISOString(),
    days_since_install: 0,

    // Default feature usage counters
    jobs_created_count: 0,
    apps_created_count: 0,
    chats_created_count: 0,
    plans_created_count: 0,

    // Default provider status
    has_anthropic: false,
    has_openai: false,
    has_google: false,
    has_papr: false,

    // Default OAuth status
    has_openai_oauth: false,
    has_anthropic_oauth: false,

    // Default settings
    theme: "system",
    telemetry_enabled: true,
    has_default_home_app: false,
  };
}

/**
 * Calculate days since install
 */
export function calculateDaysSinceInstall(firstLaunchDate: string): number {
  const first = new Date(firstLaunchDate);
  const now = new Date();
  const diffMs = now.getTime() - first.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Update user property (increment counter)
 */
export function incrementUserProperty(
  _property: keyof AmplitudeUserProperties,
  currentValue: number,
): number {
  return currentValue + 1;
}

/**
 * Get providers configured from settings
 */
export function getProvidersConfigured(settings: {
  providers: {
    anthropic?: { apiKey: string };
    openai?: { apiKey: string };
    google?: { apiKey: string };
  };
}): string[] {
  const providers: string[] = [];

  if (settings.providers.anthropic?.apiKey) providers.push("anthropic");
  if (settings.providers.openai?.apiKey) providers.push("openai");
  if (settings.providers.google?.apiKey) providers.push("google");

  return providers;
}

/**
 * Check if user has Papr configured
 */
export async function hasPaprConfigured(): Promise<boolean> {
  try {
    // Check if PAPR_API_KEY exists in custom keys
    // This would be called from main/gateway process with access to keychain
    return false; // Placeholder - implement based on your key storage
  } catch {
    return false;
  }
}
