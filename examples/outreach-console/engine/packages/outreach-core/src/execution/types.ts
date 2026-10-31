import type {
  ActionKind,
  ActionState,
  ErrorClass,
  ErrorEffect,
  ManualTaskProvider,
  ProviderAdapter,
  ProviderReceipt,
  SecretResolver,
  SqlDatabase,
} from '@splitin/outreach-contracts';

export interface ActionRow {
  id: string;
  workspace_id: string;
  enrollment_id: string | null;
  campaign_id: string | null;
  step_id: string | null;
  contact_point_id: string | null;
  kind: ActionKind;
  purpose: string | null;
  provider_account_id: string | null;
  recipient_norm: string | null;
  state: ActionState;
  due_at: number;
  not_after: number | null;
  payload: string;
  content_hash: string;
  idempotency_key: string;
  rfc_message_id: string | null;
  approval_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  max_attempts: number;
  reconcile_count: number;
  last_error_class: string | null;
  state_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface AccountRow {
  id: string;
  workspace_id: string;
  provider: string;
  external_account_id: string;
  sender_identity: string;
  purposes: string;
  capabilities: string;
  secret_ref: string;
  webhook_secret_ref: string | null;
  health: 'ok' | 'degraded' | 'unhealthy' | 'reauth_required';
}

/** What a preflight check decides. Checks run in one transaction right before the provider call. */
export type PreflightVerdict =
  | { kind: 'pass' }
  /** Not now: back to `scheduled` with a later due time (window, budget, paused campaign, unhealthy account). */
  | { kind: 'defer'; until: number; reason: string }
  /** Never: the action must not be sent (reply, opt-out, suppression, expiry). */
  | { kind: 'cancel'; reason: string }
  | { kind: 'await_approval'; reason: string }
  /** A human must look (unsupported capability, purpose not permitted, live-send gate). */
  | { kind: 'review'; reason: string };

export interface PreflightInput {
  readonly db: SqlDatabase;
  readonly action: ActionRow;
  readonly account: AccountRow | null;
  readonly adapter: ProviderAdapter | null;
  readonly now: number;
}

export type PreflightCheck = (input: PreflightInput) => PreflightVerdict;

export interface RateLimit {
  /** e.g. "account:<id>:day", "domain:example.org:day", "campaign:<id>:day". */
  readonly scopeKey: string;
  readonly windowMs: number;
  readonly limit: number;
}

export interface RatePolicy {
  readonly limits: readonly RateLimit[];
  /** Minimum time between two outbound messages to the same recipient, across campaigns. */
  readonly recipientMinGapMs?: number;
}

export type RatePolicyResolver = (db: SqlDatabase, action: ActionRow) => RatePolicy;

export interface Reservation {
  readonly scopeKey: string;
  readonly windowStart: number;
}

/**
 * Domain reactions, run inside the transaction that records an outcome. The campaign domain (M4)
 * uses them to advance or stop enrollments, suppress recipients and pause campaigns.
 */
export interface ActionEffects {
  onSucceeded?(db: SqlDatabase, action: ActionRow, receipt: ProviderReceipt | null, now: number): void;
  onFailed?(db: SqlDatabase, action: ActionRow, errorClass: ErrorClass | null, now: number): void;
  onCancelled?(db: SqlDatabase, action: ActionRow, reason: string, now: number): void;
  onErrorEffects?(db: SqlDatabase, action: ActionRow, effects: readonly ErrorEffect[], now: number): void;
}

/** Live-send gate (BUILD_PLAN.md §12): until opened by an admin, only allowlisted recipients receive email. */
export type SendGate = { readonly mode: 'open' } | { readonly mode: 'allowlist'; readonly allow: readonly string[] };

/** Test hooks that simulate a process dying at a step boundary. */
export interface CrashHooks {
  afterClaim?(actionId: string): void;
  afterPreflight?(actionId: string): void;
  beforeResult?(actionId: string): void;
}

export interface ExecutionConfig {
  readonly claimBatch: number;
  readonly claimLeaseMs: number;
  readonly executeLeaseMs: number;
  readonly providerTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly reconcileDelayMs: number;
  readonly maxReconcileAttempts: number;
  readonly unhealthyAccountDeferMs: number;
  readonly killSwitchDeferMs: number;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  claimBatch: 25,
  claimLeaseMs: 60_000,
  executeLeaseMs: 10 * 60_000,
  providerTimeoutMs: 30_000,
  backoffBaseMs: 15_000,
  backoffMaxMs: 15 * 60_000,
  reconcileDelayMs: 60_000,
  maxReconcileAttempts: 3,
  unhealthyAccountDeferMs: 5 * 60_000,
  killSwitchDeferMs: 60_000,
};

export interface ExecutionDeps {
  readonly db: SqlDatabase;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly secrets: SecretResolver;
  readonly now: () => number;
  readonly workerId: string;
  /** A fixed gate, or a resolver read inside preflight (e.g. from workspace settings). */
  readonly sendGate: SendGate | ((db: SqlDatabase, workspaceId: string) => SendGate);
  readonly config?: Partial<ExecutionConfig>;
  /** Extra checks (enrollment status, suppression, approval, send window), run after the built-ins. */
  readonly checks?: readonly PreflightCheck[];
  readonly ratePolicy?: RatePolicyResolver;
  readonly effects?: ActionEffects;
  readonly manual?: ManualTaskProvider;
  readonly hooks?: CrashHooks;
  readonly random?: () => number;
}

export function resolveConfig(deps: ExecutionDeps): ExecutionConfig {
  return { ...DEFAULT_EXECUTION_CONFIG, ...deps.config };
}
