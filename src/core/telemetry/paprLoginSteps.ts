/**
 * Papr login funnel steps for Amplitude + console diagnostics.
 * Use paprwork_papr_login_step with `step` for funnel charts.
 */

export const PAPR_LOGIN_STEP_EVENT = "paprwork_papr_login_step" as const;

export type PaprLoginStep =
  | "auth_wall_viewed"
  | "already_logged_in"
  | "login_button_clicked"
  | "browser_opened"
  | "waiting_for_callback"
  | "deep_link_queued"
  | "deep_link_flush_started"
  | "callback_received"
  | "pkce_validated"
  | "token_exchanged"
  | "user_claims_decoded"
  | "org_setup_required"
  | "org_setup_viewed"
  | "org_setup_submitted"
  | "org_setup_provisioning_started"
  | "org_setup_completed"
  | "org_setup_failed"
  | "api_key_provisioned"
  | "credentials_stored"
  | "gateway_switch_attempted"
  | "gateway_switch_failed"
  | "profile_synced"
  | "login_success_notified"
  | "poll_detected_login"
  | "login_timeout"
  | "check_again_clicked";

export type PaprLoginMode = "login" | "signup";
export type PaprLoginSource = "auth_wall" | "settings" | "unknown";

export interface PaprLoginStepProperties {
  step: PaprLoginStep;
  mode?: PaprLoginMode;
  source?: PaprLoginSource;
  error?: string;
  duration_ms?: number;
  deep_link_ready?: boolean;
  pending_count?: number;
  has_code?: boolean;
  has_state?: boolean;
  gateway_switch_success?: boolean;
  needs_org?: boolean;
  needs_namespace?: boolean;
  stage?: "form" | "provisioning";
}

export function logPaprLoginStep(
  step: PaprLoginStep,
  details?: Record<string, unknown>,
): void {
  const payload = { step, ...details };
  console.log(`[PaprLogin] funnel → ${step}`, payload);
}
