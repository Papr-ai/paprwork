import { appendAudit } from '@splitin/outreach-contracts';
import type { DomainEnv } from '../domain/env';
import { addSuppression, liveEnrollmentsForContact, stopEnrollment, verifyUnsubscribeToken } from '../domain/suppressions';

export type UnsubscribeResult = { ok: true; alreadySuppressed: boolean } | { ok: false; reason: 'not_configured' | 'invalid_token' | 'unknown_recipient' };

/**
 * One-click unsubscribe (RFC 8058) behind `POST /u/:token`. The token is verified by HMAC alone, so no
 * lookup can be probed with forged tokens. Suppression is global and immediate; every live enrollment of
 * the contact stops. Idempotent: repeated clicks are harmless.
 */
export function handleUnsubscribe(env: DomainEnv, token: string): UnsubscribeResult {
  if (!env.unsubscribe) return { ok: false, reason: 'not_configured' };
  const claims = verifyUnsubscribeToken(env.unsubscribe.secret, token);
  if (!claims) return { ok: false, reason: 'invalid_token' };
  return env.db.transaction((): UnsubscribeResult => {
    const now = env.now();
    const point = env.db
      .prepare('SELECT contact_id, value_norm FROM contact_points WHERE workspace_id = ? AND id = ?')
      .get<{ contact_id: string; value_norm: string }>(claims.w, claims.cp);
    if (!point) return { ok: false, reason: 'unknown_recipient' };
    const existing = env.db
      .prepare(`SELECT 1 FROM suppressions WHERE workspace_id = ? AND scope = 'global' AND value_norm = ?`)
      .get(claims.w, point.value_norm);
    addSuppression(env.db, { workspaceId: claims.w, scope: 'global', value: point.value_norm, reason: 'opt_out', source: `unsubscribe:${claims.c}` }, now);
    const actor = { kind: 'principal' as const, id: `recipient:${claims.cp}`, source: 'unsubscribe', traceId: claims.c };
    for (const enrollment of liveEnrollmentsForContact(env.db, claims.w, point.contact_id)) {
      stopEnrollment(env.db, enrollment.id, 'opted_out', 'unsubscribe_link', actor, now);
    }
    appendAudit(env.db, {
      workspaceId: claims.w, at: now, actorKind: 'principal', actorId: actor.id, source: 'unsubscribe', traceId: claims.c,
      resourceKind: 'contact_point', resourceId: claims.cp, action: 'unsubscribed', detail: { campaignId: claims.c, repeat: !!existing },
    });
    return { ok: true, alreadySuppressed: !!existing };
  });
}
