/**
 * Provider OAuth funnel steps for Amplitude.
 * OpenAI (ChatGPT) and Claude use separate event names for clear funnel charts.
 */

export type OAuthProviderId = "openai" | "anthropic";

export type OAuthProviderSource = "settings" | "onboarding" | "unknown";

export type OAuthProviderStep =
  | "connect_clicked"
  | "flow_started"
  | "browser_opened"
  | "callback_server_started"
  | "callback_received"
  | "token_exchanged"
  | "token_stored"
  | "key_synced"
  | "connected"
  | "connect_failed"
  | "connect_timeout"
  | "disconnected"
  | "keychain_token_found"
  | "cli_install_started"
  | "cli_install_failed"
  | "terminal_opened"
  | "manual_setup_clicked"
  | "paste_field_shown"
  | "paste_token_submitted";

export const OPENAI_OAUTH_STEP_EVENT = "paprwork_openai_oauth_step" as const;
export const CLAUDE_OAUTH_STEP_EVENT = "paprwork_claude_oauth_step" as const;
export const OPENAI_OAUTH_COMPLETED_EVENT = "paprwork_openai_oauth_completed" as const;
export const CLAUDE_OAUTH_COMPLETED_EVENT = "paprwork_claude_oauth_completed" as const;
export const OPENAI_OAUTH_FAILED_EVENT = "paprwork_openai_oauth_failed" as const;
export const CLAUDE_OAUTH_FAILED_EVENT = "paprwork_claude_oauth_failed" as const;

export interface OAuthProviderStepProperties {
  step: OAuthProviderStep;
  source?: OAuthProviderSource;
  error?: string;
  duration_ms?: number;
  stage?: "start" | "callback" | "paste" | "provisioning";
  flow_source?: "keychain" | "browser" | "terminal" | "paste";
  terminal_opened?: boolean;
  has_code?: boolean;
  has_state?: boolean;
}

export function getOAuthProviderLabel(provider: OAuthProviderId): "openai" | "claude" {
  return provider === "openai" ? "openai" : "claude";
}

export function getOAuthStepEventName(provider: OAuthProviderId): string {
  return provider === "openai" ? OPENAI_OAUTH_STEP_EVENT : CLAUDE_OAUTH_STEP_EVENT;
}

export function getOAuthCompletedEventName(provider: OAuthProviderId): string {
  return provider === "openai"
    ? OPENAI_OAUTH_COMPLETED_EVENT
    : CLAUDE_OAUTH_COMPLETED_EVENT;
}

export function getOAuthFailedEventName(provider: OAuthProviderId): string {
  return provider === "openai" ? OPENAI_OAUTH_FAILED_EVENT : CLAUDE_OAUTH_FAILED_EVENT;
}

export function logOAuthProviderStep(
  provider: OAuthProviderId,
  step: OAuthProviderStep,
  details?: Record<string, unknown>,
): void {
  const label = provider === "openai" ? "OpenAI" : "Claude";
  const payload = { step, provider: getOAuthProviderLabel(provider), ...details };
  console.log(`[${label}OAuth] funnel → ${step}`, payload);
}
