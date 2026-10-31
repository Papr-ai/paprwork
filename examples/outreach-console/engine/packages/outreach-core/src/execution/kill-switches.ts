import { appendAudit, type SqlDatabase } from '@splitin/outreach-contracts';
import type { Actor } from './actions-repo';

export type KillSwitchScope = 'global' | 'workspace' | 'provider_account' | 'campaign';

export interface KillSwitchChange {
  readonly workspaceId: string;
  readonly scope: KillSwitchScope;
  /** '*' for global and workspace scopes. */
  readonly targetId: string;
  readonly engaged: boolean;
  readonly reason: string;
}

/** Engage or release a kill switch. Must run inside a transaction. The global switch uses workspace '*'. */
export function setKillSwitch(db: SqlDatabase, change: KillSwitchChange, actor: Actor, now: number): void {
  const workspaceId = change.scope === 'global' ? '*' : change.workspaceId;
  const targetId = change.scope === 'global' || change.scope === 'workspace' ? '*' : change.targetId;
  db.prepare(
    `INSERT INTO kill_switches (workspace_id, scope, target_id, engaged, reason, changed_by, changed_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (workspace_id, scope, target_id)
     DO UPDATE SET engaged = excluded.engaged, reason = excluded.reason,
       changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
  ).run(workspaceId, change.scope, targetId, change.engaged ? 1 : 0, change.reason, actor.id, now);
  appendAudit(db, {
    workspaceId: change.workspaceId,
    at: now,
    actorKind: actor.kind,
    actorId: actor.id,
    source: actor.source,
    traceId: actor.traceId,
    resourceKind: 'kill_switch',
    resourceId: `${change.scope}:${targetId}`,
    action: change.engaged ? 'engaged' : 'released',
    detail: { reason: change.reason },
  });
}

/** Returns the first engaged switch that covers this action, or null. */
export function engagedKillSwitch(
  db: SqlDatabase,
  workspaceId: string,
  providerAccountId: string | null,
  campaignId: string | null,
): string | null {
  const row = db
    .prepare(
      `SELECT scope FROM kill_switches WHERE engaged = 1 AND (
         (scope = 'global') OR
         (scope = 'workspace' AND workspace_id = ?) OR
         (scope = 'provider_account' AND workspace_id = ? AND target_id = ?) OR
         (scope = 'campaign' AND workspace_id = ? AND target_id = ?)
       ) ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'workspace' THEN 1 WHEN 'provider_account' THEN 2 ELSE 3 END
       LIMIT 1`,
    )
    .get<{ scope: string }>(workspaceId, workspaceId, providerAccountId ?? '', workspaceId, campaignId ?? '');
  return row?.scope ?? null;
}
