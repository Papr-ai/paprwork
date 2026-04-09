/**
 * Amplitude Event Definitions
 * Central registry of all tracked events with their properties
 */

// ============================================
// Event Names (Centralized)
// ============================================

export const AmplitudeEvents = {
  // Lifecycle Events
  APP_STARTED: "paprwork_app_started",
  APP_QUIT: "paprwork_app_quit",
  SYSTEM_SUSPEND: "paprwork_system_suspend",
  SYSTEM_RESUME: "paprwork_system_resume",
  WINDOW_FOCUSED: "paprwork_window_focused",
  WINDOW_MINIMIZED: "paprwork_window_minimized",

  // Onboarding Events
  ONBOARDING_STARTED: "paprwork_onboarding_started",
  ONBOARDING_STEP_VIEWED: "paprwork_onboarding_step_viewed",
  ONBOARDING_STEP_COMPLETED: "paprwork_onboarding_step_completed",
  ONBOARDING_COMPLETED: "paprwork_onboarding_completed",
  PAPR_LOGIN_STARTED: "paprwork_papr_login_started",
  PAPR_LOGIN_COMPLETED: "paprwork_papr_login_completed",

  // Chat Events
  CHAT_CREATED: "paprwork_chat_created",
  MESSAGE_SENT: "paprwork_message_sent",
  MESSAGE_RECEIVED: "paprwork_message_received",
  CHAT_DELETED: "paprwork_chat_deleted",
  CHAT_RENAMED: "paprwork_chat_renamed",
  MODEL_CHANGED: "paprwork_model_changed",

  // Tool Usage Events
  TOOL_CALLED: "paprwork_tool_called",
  BASH_COMMAND_EXECUTED: "paprwork_bash_command_executed",
  FILE_READ: "paprwork_file_read",
  FILE_WRITTEN: "paprwork_file_written",
  BROWSER_ACTION: "paprwork_browser_action",

  // Job Events
  JOB_CREATED: "paprwork_job_created",
  JOB_COMPLETED: "paprwork_job_completed",
  JOB_FAILED: "paprwork_job_failed",
  JOB_EDITED: "paprwork_job_edited",
  JOB_DELETED: "paprwork_job_deleted",
  SCHEDULER_JOB_TRIGGERED: "paprwork_scheduler_job_triggered",
  SCHEDULER_JOB_FAILED: "paprwork_scheduler_job_failed",

  // Mini-App Events
  APP_CREATED: "paprwork_app_created",
  APP_OPENED: "paprwork_app_opened",
  APP_CLOSED: "paprwork_app_closed",
  APP_EDITED: "paprwork_app_edited",
  APP_DELETED: "paprwork_app_deleted",
  HOME_APP_SET: "paprwork_home_app_set",

  // Plan Events
  PLAN_CREATED: "paprwork_plan_created",
  PLAN_STEP_COMPLETED: "paprwork_plan_step_completed",
  PLAN_COMPLETED: "paprwork_plan_completed",
  PLAN_DELETED: "paprwork_plan_deleted",

  // Settings Events
  SETTINGS_OPENED: "paprwork_settings_opened",
  PROVIDER_CONFIGURED: "paprwork_provider_configured",
  TELEMETRY_TOGGLED: "paprwork_telemetry_toggled",
  THEME_CHANGED: "paprwork_theme_changed",
  DEFAULT_MODEL_CHANGED: "paprwork_default_model_changed",

  // Error Events
  ERROR_OCCURRED: "paprwork_error_occurred",
  API_ERROR: "paprwork_api_error",
  JOB_ERROR: "paprwork_job_error",

  // Performance Events
  SLOW_OPERATION: "paprwork_slow_operation",
  DATABASE_QUERY_SLOW: "paprwork_database_query_slow",
  WEBSOCKET_LATENCY: "paprwork_websocket_latency",
} as const;

// ============================================
// Event Property Interfaces
// ============================================

export interface BaseEventProperties {
  // Common properties added to all events
  client?: string;
  app_version?: string;
  platform?: string;
}

export interface AppStartedProperties extends BaseEventProperties {
  first_launch?: boolean;
  providers_configured?: string[]; // ["anthropic", "openai"]
  days_since_install?: number;
  has_papr?: boolean;
}

export interface OnboardingStepProperties extends BaseEventProperties {
  step_number: number;
  step_name: string;
}

export interface OnboardingCompletedProperties extends BaseEventProperties {
  time_spent_seconds: number;
  steps_completed: number;
}

export interface MessageSentProperties extends BaseEventProperties {
  message_length: number;
  has_attachments: boolean;
  model: string;
  provider: string;
}

export interface MessageReceivedProperties extends BaseEventProperties {
  response_time_ms: number;
  token_count?: number;
  cost?: number;
  model: string;
  provider: string;
}

export interface ModelChangedProperties extends BaseEventProperties {
  from_model: string;
  to_model: string;
  provider: string;
}

export interface ToolCalledProperties extends BaseEventProperties {
  tool_name: string;
  success: boolean;
  duration_ms: number;
  error_message?: string;
}

export interface BashCommandProperties extends BaseEventProperties {
  success: boolean;
  duration_ms: number;
  exit_code?: number;
}

export interface BrowserActionProperties extends BaseEventProperties {
  action_type: "navigate" | "click" | "type" | "snapshot" | "scroll";
  success: boolean;
  duration_ms: number;
}

export interface JobCreatedProperties extends BaseEventProperties {
  job_id: string;
  job_type: "python" | "node" | "bash" | "shell" | "agent" | "subagent" | "swift";
  has_schedule: boolean;
  has_dependencies: boolean;
  schedule_type?: "interval" | "cron" | "at_time";
}

export interface JobCompletedProperties extends BaseEventProperties {
  job_id: string;
  job_type: string;
  duration_ms: number;
  exit_code?: number;
  had_retry: boolean;
  output_size_bytes?: number;
  scheduled: boolean;
}

export interface JobFailedProperties extends BaseEventProperties {
  job_id: string;
  job_type: string;
  error_type: string;
  error_message?: string;
  attempt_number: number;
  max_attempts: number;
}

export interface AppCreatedProperties extends BaseEventProperties {
  app_id: string;
  has_icon: boolean;
  has_data_sources: boolean;
}

export interface AppOpenedProperties extends BaseEventProperties {
  app_id: string;
  open_source: "tab" | "home_button";
}

export interface AppClosedProperties extends BaseEventProperties {
  app_id: string;
  time_open_ms: number;
}

export interface PlanCreatedProperties extends BaseEventProperties {
  plan_id: string;
  step_count: number;
}

export interface PlanStepCompletedProperties extends BaseEventProperties {
  plan_id: string;
  step_index: number;
  total_steps: number;
}

export interface PlanCompletedProperties extends BaseEventProperties {
  plan_id: string;
  time_spent_seconds: number;
  steps_count: number;
}

export interface SettingsOpenedProperties extends BaseEventProperties {
  section: "providers" | "preferences" | "profile" | "api_keys" | "permissions";
}

export interface ProviderConfiguredProperties extends BaseEventProperties {
  provider: "anthropic" | "openai" | "google" | "papr";
  method: "api_key" | "oauth";
}

export interface TelemetryToggledProperties extends BaseEventProperties {
  enabled: boolean;
}

export interface ThemeChangedProperties extends BaseEventProperties {
  from_theme: "light" | "dark" | "system";
  to_theme: "light" | "dark" | "system";
}

export interface DefaultModelChangedProperties extends BaseEventProperties {
  provider: string;
  from_model: string;
  to_model: string;
}

export interface ErrorOccurredProperties extends BaseEventProperties {
  error_type: string;
  error_message: string;
  context?: string;
  stack_trace?: string;
}

export interface ApiErrorProperties extends BaseEventProperties {
  provider: string;
  status_code?: number;
  error_message: string;
  endpoint?: string;
}

export interface SlowOperationProperties extends BaseEventProperties {
  operation_name: string;
  duration_ms: number;
  threshold_ms: number;
}

export interface DatabaseQuerySlowProperties extends BaseEventProperties {
  query_type: string;
  duration_ms: number;
  threshold_ms: number;
}

export interface WebsocketLatencyProperties extends BaseEventProperties {
  latency_ms: number;
  event_type: string;
}

// ============================================
// Type Guards
// ============================================

export function isValidEventName(name: string): name is keyof typeof AmplitudeEvents {
  return Object.values(AmplitudeEvents).includes(name as any);
}

// ============================================
// Event Property Validation
// ============================================

/**
 * Sanitize event properties to ensure they're safe for Amplitude
 * - Remove undefined values
 * - Truncate long strings
 * - Convert dates to ISO strings
 */
export function sanitizeEventProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    // Skip undefined values
    if (value === undefined) continue;

    // Convert dates to ISO strings
    if (value instanceof Date) {
      sanitized[key] = value.toISOString();
      continue;
    }

    // Truncate long strings (max 1024 chars for Amplitude)
    if (typeof value === "string" && value.length > 1024) {
      sanitized[key] = value.substring(0, 1021) + "...";
      continue;
    }

    // Pass through primitives and objects
    sanitized[key] = value;
  }

  return sanitized;
}
