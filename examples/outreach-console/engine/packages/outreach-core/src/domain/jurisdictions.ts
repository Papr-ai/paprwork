import { z } from 'zod';
import type { SqlDatabase } from '@splitin/outreach-contracts';
import { ForbiddenError, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';

/**
 * Where a recipient is decides which law applies (BUILD_PLAN.md decision D5). The workspace records, per
 * ISO 3166 country, what a message needs before it may go out; the record carries who signed it off.
 *
 * - `allow`: no consent requirement beyond the playbook's own eligibility rules (e.g. US CAN-SPAM).
 * - `consent_required`: only contacts with recorded consent or an existing relationship (e.g. DE, CA).
 * - `block`: never send.
 */
export const JURISDICTION_RULES = ['allow', 'consent_required', 'block'] as const;
export type JurisdictionRule = (typeof JURISDICTION_RULES)[number];

const Rule = z.enum(JURISDICTION_RULES);
export const JurisdictionCode = z.string().regex(/^[A-Z]{2}$/, 'country codes are ISO 3166 alpha-2, upper case');

export const JurisdictionPolicyInput = z.strictObject({
  rules: z.record(JurisdictionCode, Rule),
  /** Countries not listed in `rules`. */
  default: Rule,
  /** Contacts whose country was never recorded. */
  unknown: Rule,
});
export type JurisdictionPolicyInput = z.infer<typeof JurisdictionPolicyInput>;

export interface JurisdictionSignoff {
  /** The person accountable for the legal basis, e.g. counsel or the founder. */
  readonly by: string;
  /** Where the decision is recorded: a memo, ticket or document link. */
  readonly reference: string;
}

export interface JurisdictionPolicy extends JurisdictionPolicyInput {
  readonly signoff: JurisdictionSignoff & { readonly at: number; readonly recordedBy: string };
}

export type JurisdictionVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Consent bases that satisfy `consent_required`. Legitimate interest does not. */
const CONSENTED = new Set(['consent', 'existing_relationship']);

function settingsOf(db: SqlDatabase, workspaceId: string): Record<string, unknown> {
  const row = db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(workspaceId);
  return JSON.parse(row?.settings ?? '{}') as Record<string, unknown>;
}

/** The signed-off policy, or null when none has been recorded (sending is then limited by the live-send gate). */
export function readJurisdictionPolicy(db: SqlDatabase, workspaceId: string): JurisdictionPolicy | null {
  const stored = settingsOf(db, workspaceId).jurisdictions as JurisdictionPolicy | undefined;
  return stored && JurisdictionPolicyInput.safeParse({ rules: stored.rules, default: stored.default, unknown: stored.unknown }).success ? stored : null;
}

/** Records the policy and its sign-off in one audited change. Admin only. */
export function setJurisdictionPolicy(env: DomainEnv, ctx: AuthContext, input: JurisdictionPolicyInput, signoff: JurisdictionSignoff): JurisdictionPolicy {
  requireRole(ctx, 'admin');
  const parsed = JurisdictionPolicyInput.parse(input);
  if (signoff.by.trim().length < 2 || signoff.reference.trim().length < 5) {
    throw new ForbiddenError('a jurisdiction policy needs a sign-off: who approved it (--signed-off-by) and where it is recorded (--reference)');
  }
  return env.db.transaction(() => {
    const now = env.now();
    const policy: JurisdictionPolicy = {
      ...parsed,
      signoff: { by: signoff.by.trim(), reference: signoff.reference.trim(), at: now, recordedBy: ctx.principalId },
    };
    const settings = { ...settingsOf(env.db, ctx.workspaceId), jurisdictions: policy };
    env.db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), ctx.workspaceId);
    audit(env.db, ctx, now, 'workspace', ctx.workspaceId, 'jurisdiction_policy_changed', { policy });
    return policy;
  });
}

/** Normalizes a stored jurisdiction to an ISO code, or null when unknown. */
export function normalizeJurisdiction(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Whether a message to a contact point in `jurisdiction` with `consentBasis` is permitted. No policy: permitted. */
export function jurisdictionVerdict(policy: JurisdictionPolicy | null, jurisdiction: string | null, consentBasis: string | null): JurisdictionVerdict {
  if (!policy) return { ok: true };
  const code = normalizeJurisdiction(jurisdiction);
  const rule = code ? (policy.rules[code] ?? policy.default) : policy.unknown;
  const label = code ?? 'unknown';
  if (rule === 'allow') return { ok: true };
  if (rule === 'block') return { ok: false, reason: `jurisdiction_blocked:${label}` };
  return CONSENTED.has(consentBasis ?? '') ? { ok: true } : { ok: false, reason: `jurisdiction_needs_consent:${label}` };
}

/** The verdict for the contact point an action is addressed to. */
export function contactPointVerdict(db: SqlDatabase, workspaceId: string, contactPointId: string | null): JurisdictionVerdict {
  const policy = readJurisdictionPolicy(db, workspaceId);
  if (!policy) return { ok: true };
  const row = contactPointId
    ? db.prepare('SELECT jurisdiction, consent_basis FROM contact_points WHERE id = ?').get<{ jurisdiction: string | null; consent_basis: string | null }>(contactPointId)
    : undefined;
  return jurisdictionVerdict(policy, row?.jurisdiction ?? null, row?.consent_basis ?? null);
}
