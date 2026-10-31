import { loadAction, transitionAction, type Actor } from './actions-repo';
import { completeSuccess } from './results';
import type { ExecutionDeps } from './types';

export type ReviewResolution =
  /** A human verified the message went out (e.g. found it in the sent folder). */
  | { kind: 'sent'; providerMessageId: string; providerThreadId?: string }
  /** A human verified it did not go out; send it now. */
  | { kind: 'not_sent_retry' }
  /** Do not send. */
  | { kind: 'drop'; reason: string };

export class ReviewStateError extends Error {
  constructor(actionId: string) {
    super(`Action ${actionId} is not awaiting review`);
    this.name = 'ReviewStateError';
  }
}

/** Human resolution of a `review` action. Authorization is the caller's job (services layer). */
export function resolveReviewAction(deps: ExecutionDeps, actionId: string, resolution: ReviewResolution, actor: Actor): void {
  deps.db.transaction(() => {
    const now = deps.now();
    const action = loadAction(deps.db, actionId);
    if (!action || action.state !== 'review') throw new ReviewStateError(actionId);
    if (resolution.kind === 'sent') {
      const attempt = deps.db
        .prepare('SELECT id FROM action_attempts WHERE action_id = ? ORDER BY attempt_no DESC LIMIT 1')
        .get<{ id: string }>(actionId);
      const attemptId = attempt?.id;
      if (!attemptId) throw new ReviewStateError(actionId);
      completeSuccess(
        deps,
        action,
        attemptId,
        {
          providerMessageId: resolution.providerMessageId,
          acceptedAt: now,
          ...(resolution.providerThreadId ? { providerThreadId: resolution.providerThreadId } : {}),
          ...(action.rfc_message_id ? { rfcMessageId: action.rfc_message_id } : {}),
        },
        now,
        actor,
      );
      return;
    }
    if (resolution.kind === 'not_sent_retry') {
      transitionAction(deps.db, action, 'scheduled', now, actor, { due_at: now, state_reason: 'review:not_sent' });
      return;
    }
    const cancelled = transitionAction(deps.db, action, 'cancelled', now, actor, { state_reason: `review:${resolution.reason}` });
    deps.effects?.onCancelled?.(deps.db, cancelled, resolution.reason, now);
  });
}
