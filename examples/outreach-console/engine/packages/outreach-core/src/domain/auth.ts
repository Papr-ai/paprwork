import { appendAudit, type SqlDatabase } from '@splitin/outreach-contracts';
import type { Actor } from '../execution/actions-repo';

/** Roles are cumulative: each includes everything below it (BUILD_PLAN.md §9.1). */
export const ROLES = ['viewer', 'operator', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Surface = 'cli' | 'http' | 'mcp' | 'slack' | 'papr' | 'system' | 'test';

/** Always derived from authenticated context by a surface, never from tool arguments or payloads. */
export interface AuthContext {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly roles: readonly Role[];
  readonly source: Surface;
  readonly traceId: string;
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

function rank(role: Role): number {
  return ROLES.indexOf(role);
}

export function hasRole(ctx: AuthContext, required: Role): boolean {
  return ctx.roles.some((role) => rank(role) >= rank(required));
}

export function requireRole(ctx: AuthContext, required: Role): void {
  if (!hasRole(ctx, required)) throw new ForbiddenError(`${required} role required`);
}

export function actorOf(ctx: AuthContext): Actor {
  return { kind: ctx.source === 'system' ? 'system' : 'principal', id: ctx.principalId, source: ctx.source, traceId: ctx.traceId };
}

export function audit(
  db: SqlDatabase,
  ctx: AuthContext,
  now: number,
  resourceKind: string,
  resourceId: string,
  action: string,
  detail: Record<string, unknown> = {},
): void {
  const actor = actorOf(ctx);
  appendAudit(db, {
    workspaceId: ctx.workspaceId,
    at: now,
    actorKind: actor.kind,
    actorId: actor.id,
    source: actor.source,
    traceId: actor.traceId,
    resourceKind,
    resourceId,
    action,
    detail,
  });
}

interface PrincipalRow {
  id: string;
  roles: string;
}

/**
 * Resolves an authenticated external identity (e.g. "slack:T1:U2", "cli:alice") to a principal.
 * Unknown identities get no roles and therefore can do nothing.
 */
export function authenticate(
  db: SqlDatabase,
  workspaceId: string,
  externalRef: string,
  source: Surface,
  traceId: string,
): AuthContext {
  const row = db
    .prepare('SELECT id, roles FROM principals WHERE workspace_id = ? AND external_ref = ?')
    .get<PrincipalRow>(workspaceId, externalRef);
  if (!row) throw new ForbiddenError(`unknown principal ${externalRef}`);
  const roles = (JSON.parse(row.roles) as string[]).filter((role): role is Role => (ROLES as readonly string[]).includes(role));
  return { workspaceId, principalId: row.id, roles, source, traceId };
}

export function systemContext(workspaceId: string, traceId: string): AuthContext {
  return { workspaceId, principalId: 'system', roles: ['admin'], source: 'system', traceId };
}
