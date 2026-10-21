import type { ErrorEffect, SqlDatabase } from '@splitin/outreach-contracts';
import type { Actor } from '../execution/actions-repo';
import type { ActionEffects, ActionRow, PreflightCheck, RatePolicy, RateLimit } from '../execution/types';
import { approvalVerdict } from './approvals';
import { actionApprover } from './campaigns';
import { durationMs, nextSlot, resolveZone } from './calendar';
import { loadEnrollment, loadVersion, type DomainEnv } from './env';
import { loadStepContext, materializeNext, stepIndex } from './materialize';
import type { Policy } from './playbook';
import { contactPointVerdict } from './jurisdictions';
import { addSuppression, isSuppressed, stopEnrollment } from './suppressions';

const PAUSED_DEFER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

function engineActor(action: ActionRow): Actor {
  return { kind: 'worker', id: 'engine', source: 'worker', traceId: action.id };
}

function policyOf(db: SqlDatabase, action: ActionRow): Policy | null {
  if (!action.enrollment_id) return null;
  const enrollment = loadEnrollment(db, action.enrollment_id);
  const version = enrollment ? loadVersion(db, enrollment.campaign_version_id) : undefined;
  return version ? (JSON.parse(version.policy) as Policy) : null;
}

/** Domain checks, run inside preflight after the kill-switch and expiry checks (BUILD_PLAN.md §6.4). */
export function domainChecks(): PreflightCheck[] {
  const enrollmentLive: PreflightCheck = ({ db, action, now }) => {
    if (!action.enrollment_id) return { kind: 'pass' };
    const enrollment = loadEnrollment(db, action.enrollment_id);
    if (!enrollment) return { kind: 'cancel', reason: 'enrollment_missing' };
    if (enrollment.status === 'paused') return { kind: 'defer', until: now + PAUSED_DEFER_MS, reason: 'enrollment_paused' };
    return enrollment.status === 'active' ? { kind: 'pass' } : { kind: 'cancel', reason: `enrollment_${enrollment.status}` };
  };
  const campaignLive: PreflightCheck = ({ db, action, now }) => {
    if (!action.campaign_id) return { kind: 'pass' };
    const row = db.prepare('SELECT status FROM campaigns WHERE id = ?').get<{ status: string }>(action.campaign_id);
    if (row?.status === 'paused') return { kind: 'defer', until: now + PAUSED_DEFER_MS, reason: 'campaign_paused' };
    return row?.status === 'active' ? { kind: 'pass' } : { kind: 'cancel', reason: `campaign_${row?.status ?? 'missing'}` };
  };
  const notSuppressed: PreflightCheck = ({ db, action }) => {
    if (!action.recipient_norm || action.kind === 'notify.publish') return { kind: 'pass' };
    const hit = isSuppressed(db, action.workspace_id, action.recipient_norm, action.provider_account_id);
    return hit ? { kind: 'cancel', reason: `suppressed:${hit}` } : { kind: 'pass' };
  };
  // Re-checked at send time: the policy may have changed since the audience was snapshotted.
  const lawfulBasis: PreflightCheck = ({ db, action }) => {
    if (action.kind !== 'email.send' && action.kind !== 'email.reply') return { kind: 'pass' };
    const verdict = contactPointVerdict(db, action.workspace_id, action.contact_point_id);
    return verdict.ok ? { kind: 'pass' } : { kind: 'cancel', reason: verdict.reason };
  };
  const approved: PreflightCheck = ({ db, action, now }) => approvalVerdict(db, action, now);
  const inWindow: PreflightCheck = ({ db, action, now }) => {
    if (action.kind !== 'email.send' && action.kind !== 'email.reply') return { kind: 'pass' };
    const policy = policyOf(db, action);
    if (!policy || !action.enrollment_id) return { kind: 'pass' };
    const contact = db
      .prepare('SELECT c.timezone FROM enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.id = ?')
      .get<{ timezone: string | null }>(action.enrollment_id);
    const slot = nextSlot(now, policy.window, resolveZone(policy.window, contact?.timezone));
    return slot > now ? { kind: 'defer', until: slot, reason: 'outside_send_window' } : { kind: 'pass' };
  };
  return [enrollmentLive, campaignLive, notSuppressed, lawfulBasis, approved, inWindow];
}

/** Per-campaign budgets from the playbook policy; notifications and manual tasks are not budgeted. */
export function domainRatePolicy(db: SqlDatabase, action: ActionRow): RatePolicy {
  const policy = policyOf(db, action);
  if (!policy || (action.kind !== 'email.send' && action.kind !== 'email.reply')) return { limits: [] };
  const limits: RateLimit[] = [
    { scopeKey: `account:${action.provider_account_id}:day`, windowMs: DAY_MS, limit: policy.limits.accountPerDay },
  ];
  const domain = action.recipient_norm?.split('@')[1];
  if (domain) limits.push({ scopeKey: `domain:${domain}:day`, windowMs: DAY_MS, limit: policy.limits.domainPerDay });
  if (policy.limits.campaignPerDay && action.campaign_id) {
    limits.push({ scopeKey: `campaign:${action.campaign_id}:day`, windowMs: DAY_MS, limit: policy.limits.campaignPerDay });
  }
  // The gap applies from the second touch on: a reply step follows its own send by design.
  const gap = action.kind === 'email.send' ? durationMs(policy.limits.recipientMinGap) : 0;
  return { limits, recipientMinGapMs: gap };
}

/** Enrollment progression and stop rules, run inside the transaction that records each outcome. */
export function domainEffects(env: DomainEnv): ActionEffects {
  return {
    onSucceeded(db, action, _receipt, now) {
      if (action.approval_id) db.prepare('UPDATE approvals SET consumed_count = consumed_count + 1 WHERE id = ?').run(action.approval_id);
      // A manual task advances only when a human records its outcome.
      if (!action.enrollment_id || action.kind === 'manual.task') return;
      const sc = loadStepContext(db, action.enrollment_id);
      if (!sc) return;
      materializeNext(env, sc, stepIndex(sc, action.step_id), now, engineActor(action), {
        requestActionApproval: actionApprover(env, action.workspace_id, 'engine'),
      });
    },
    onFailed(db, action, errorClass, now) {
      if (!action.enrollment_id) return;
      stopEnrollment(db, action.enrollment_id, 'error', `action_failed:${errorClass ?? action.state_reason ?? 'unknown'}`, engineActor(action), now);
    },
    onCancelled(db, action, reason, now) {
      if (!action.enrollment_id) return;
      if (reason.startsWith('suppressed') || reason.startsWith('jurisdiction_')) stopEnrollment(db, action.enrollment_id, 'stopped', reason, engineActor(action), now);
      else if (reason === 'expired') stopEnrollment(db, action.enrollment_id, 'stopped', 'step_expired', engineActor(action), now);
    },
    onErrorEffects(db, action, effects: readonly ErrorEffect[], now) {
      if (effects.includes('suppress_recipient') && action.recipient_norm) {
        addSuppression(db, {
          workspaceId: action.workspace_id,
          scope: 'channel',
          channel: 'email',
          value: action.recipient_norm,
          reason: action.last_error_class === 'complaint' ? 'complaint' : 'hard_bounce',
          source: `action:${action.id}`,
        }, now);
      }
      if (effects.includes('bounce_enrollment') && action.enrollment_id) {
        stopEnrollment(db, action.enrollment_id, 'bounced', action.last_error_class ?? 'bounce', engineActor(action), now);
      }
      if (effects.includes('pause_campaign') && action.campaign_id) {
        db.prepare(`UPDATE campaigns SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
          .run(`provider:${action.last_error_class ?? 'error'}`, now, action.campaign_id);
      }
    },
  };
}
