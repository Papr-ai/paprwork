/**
 * Provider error taxonomy (BUILD_PLAN.md §5.3). Adapters map every failure into one class;
 * the engine decides behaviour from the class alone, so no provider logic lives in the core.
 */
export const ERROR_CLASSES = [
  'auth_expired',
  'auth_revoked',
  'forbidden',
  'rate_limited',
  'invalid_recipient',
  'hard_bounce',
  'content_rejected',
  'policy_blocked',
  'complaint',
  'transient',
  'unsupported',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export type ErrorEffect =
  | 'suppress_recipient'
  | 'bounce_enrollment'
  | 'account_unhealthy'
  | 'account_reauth'
  | 'engage_account_kill'
  | 'pause_campaign';

export interface ErrorDisposition {
  /** `backoff`: retry after jittered delay; `after_reauth`: retry once the account is healthy again. */
  readonly retry: 'never' | 'backoff' | 'after_reauth';
  /** Final action state when not retried. */
  readonly terminal: 'failed' | 'review' | null;
  readonly effects: readonly ErrorEffect[];
}

const permanentAccount: ErrorDisposition = {
  retry: 'never',
  terminal: 'failed',
  effects: ['account_unhealthy', 'pause_campaign'],
};
const badRecipient: ErrorDisposition = {
  retry: 'never',
  terminal: 'failed',
  effects: ['suppress_recipient', 'bounce_enrollment'],
};

export const ERROR_DISPOSITIONS: Readonly<Record<ErrorClass, ErrorDisposition>> = {
  auth_expired: { retry: 'after_reauth', terminal: null, effects: ['account_reauth'] },
  auth_revoked: permanentAccount,
  forbidden: permanentAccount,
  rate_limited: { retry: 'backoff', terminal: null, effects: [] },
  invalid_recipient: badRecipient,
  hard_bounce: badRecipient,
  content_rejected: { retry: 'never', terminal: 'review', effects: [] },
  policy_blocked: { retry: 'never', terminal: 'failed', effects: ['engage_account_kill'] },
  complaint: { retry: 'never', terminal: 'failed', effects: ['engage_account_kill', 'suppress_recipient'] },
  transient: { retry: 'backoff', terminal: null, effects: [] },
  unsupported: { retry: 'never', terminal: 'failed', effects: [] },
};

export function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === 'string' && (ERROR_CLASSES as readonly string[]).includes(value);
}
