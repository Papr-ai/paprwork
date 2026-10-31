/**
 * The action state machine (BUILD_PLAN.md §6.1, ADR 0002).
 *
 * `claimed` means a worker holds the lease but has not committed to acting: a crash is harmless.
 * `executing` is committed together with a pending attempt BEFORE the provider call, so a crash
 * after that point can only lead to `uncertain`, never to a blind resend.
 */
export const ACTION_STATES = [
  'planned',
  'awaiting_approval',
  'scheduled',
  'claimed',
  'executing',
  'succeeded',
  'retryable',
  'uncertain',
  'reconciling',
  'failed',
  'cancelled',
  'review',
] as const;

export type ActionState = (typeof ACTION_STATES)[number];

export const ACTION_KINDS = ['email.send', 'email.reply', 'notify.publish', 'manual.task'] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  planned: ['awaiting_approval', 'scheduled', 'cancelled'],
  awaiting_approval: ['scheduled', 'cancelled'],
  scheduled: ['claimed', 'awaiting_approval', 'cancelled'],
  // Preflight either proceeds, defers, blocks, or parks the action for a human.
  claimed: ['executing', 'scheduled', 'awaiting_approval', 'cancelled', 'review'],
  executing: ['succeeded', 'retryable', 'failed', 'uncertain', 'review'],
  retryable: ['scheduled', 'failed', 'cancelled'],
  // An uncertain action is never cancelled or retried directly: only reconciliation or a human decides.
  uncertain: ['reconciling', 'review'],
  reconciling: ['succeeded', 'scheduled', 'failed', 'uncertain', 'review'],
  succeeded: [],
  failed: [],
  cancelled: [],
  // A human resolves review items: sent, not sent (reschedule or drop), or failed.
  review: ['succeeded', 'scheduled', 'failed', 'cancelled'],
};

export const TERMINAL_ACTION_STATES: readonly ActionState[] = ['succeeded', 'failed', 'cancelled'];

/** States a stop (reply, opt-out, bounce, pause-to-stop) may cancel. `executing` and `uncertain` cannot be recalled. */
export const CANCELLABLE_ACTION_STATES: readonly ActionState[] = [
  'planned',
  'awaiting_approval',
  'scheduled',
  'claimed',
  'retryable',
];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ActionState,
    readonly to: ActionState,
  ) {
    super(`Invalid action transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function isActionState(value: unknown): value is ActionState {
  return typeof value === 'string' && (ACTION_STATES as readonly string[]).includes(value);
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
