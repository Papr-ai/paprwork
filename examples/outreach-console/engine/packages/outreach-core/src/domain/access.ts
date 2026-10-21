import { randomBytes } from 'node:crypto';
import { safeEqualHex, sha256Hex, ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import type { SendGate } from '../execution/types';
import { ForbiddenError, NotFoundError, ROLES, audit, requireRole, type AuthContext, type Role, type Surface } from './auth';
import type { DomainEnv } from './env';
import { readJurisdictionPolicy } from './jurisdictions';

const TOKEN_RE = /^oet_([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/;

export interface CreatedToken {
  readonly id: string;
  /** Shown once. Only a SHA-256 of the secret part is stored. */
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Issues a bearer token for a principal (BUILD_PLAN.md §11.2). The token can never carry more than the
 * principal's own roles, and `roleCeiling` narrows it further (e.g. a read-only dashboard token).
 */
export function createApiToken(
  env: DomainEnv,
  ctx: AuthContext,
  input: { principalId: string; name: string; roleCeiling: Role; ttlDays: number },
): CreatedToken {
  requireRole(ctx, 'admin');
  if (input.ttlDays < 1 || input.ttlDays > 366) throw new Error('ttlDays must be between 1 and 366');
  return env.db.transaction(() => {
    const now = env.now();
    const principal = env.db.prepare('SELECT id FROM principals WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, input.principalId);
    if (!principal) throw new NotFoundError(`principal ${input.principalId}`);
    const id = ulid(now);
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + input.ttlDays * 86_400_000;
    env.db.prepare(
      `INSERT INTO api_tokens (id, workspace_id, principal_id, name, secret_sha256, role_ceiling, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, ctx.workspaceId, input.principalId, input.name, sha256Hex(secret), input.roleCeiling, now, expiresAt);
    audit(env.db, ctx, now, 'api_token', id, 'created', { principalId: input.principalId, name: input.name, roleCeiling: input.roleCeiling, expiresAt });
    return { id, token: `oet_${id}.${secret}`, expiresAt };
  });
}

export function revokeApiToken(env: DomainEnv, ctx: AuthContext, tokenId: string): void {
  requireRole(ctx, 'admin');
  env.db.transaction(() => {
    const now = env.now();
    const changed = env.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL').run(now, ctx.workspaceId, tokenId);
    if (changed.changes !== 1) throw new NotFoundError(`active token ${tokenId}`);
    audit(env.db, ctx, now, 'api_token', tokenId, 'revoked');
  });
}

interface TokenRow {
  workspace_id: string;
  principal_id: string;
  secret_sha256: string;
  role_ceiling: Role;
  expires_at: number;
  revoked_at: number | null;
  roles: string;
}

/** Resolves a bearer token to an AuthContext. Every failure is the same ForbiddenError (no oracle). */
export function authenticateToken(db: SqlDatabase, token: string, source: Surface, traceId: string, now: number): AuthContext {
  const match = TOKEN_RE.exec(token.trim());
  const denied = new ForbiddenError('invalid or expired token');
  if (!match) throw denied;
  const [, id, secret] = match;
  const row = db
    .prepare(
      `SELECT t.workspace_id, t.principal_id, t.secret_sha256, t.role_ceiling, t.expires_at, t.revoked_at, p.roles
       FROM api_tokens t JOIN principals p ON p.id = t.principal_id WHERE t.id = ?`,
    )
    .get<TokenRow>(id ?? '');
  if (!row || !safeEqualHex(sha256Hex(secret ?? ''), row.secret_sha256) || row.revoked_at !== null || now > row.expires_at) throw denied;
  // Roles are cumulative, so the effective role is the lower of the principal's highest role and the ceiling.
  const highest = Math.max(-1, ...(JSON.parse(row.roles) as string[]).map((role) => ROLES.indexOf(role as Role)));
  const effective = Math.min(highest, ROLES.indexOf(row.role_ceiling));
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, id ?? '');
  const role = ROLES[effective];
  return { workspaceId: row.workspace_id, principalId: row.principal_id, roles: role ? [role] : [], source, traceId };
}

/** The live-send gate is workspace state, changed only by an admin through an audited action (plan §12). */
export function readSendGate(db: SqlDatabase, workspaceId: string): SendGate {
  const row = db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(workspaceId);
  const gate = (JSON.parse(row?.settings ?? '{}') as { sendGate?: SendGate }).sendGate;
  if (gate?.mode === 'open') return { mode: 'open' };
  if (gate?.mode === 'allowlist' && Array.isArray(gate.allow)) return { mode: 'allowlist', allow: gate.allow.map(String) };
  return { mode: 'allowlist', allow: [] };
}

export function setSendGate(env: DomainEnv, ctx: AuthContext, gate: SendGate, reason: string): void {
  requireRole(ctx, 'admin');
  if (gate.mode === 'open' && reason.trim().length < 10) throw new ForbiddenError('opening the live-send gate needs a written reason (at least 10 characters)');
  // Decision D5: nothing goes to arbitrary recipients until someone has signed off where it may go.
  if (gate.mode === 'open' && !readJurisdictionPolicy(env.db, ctx.workspaceId)) {
    throw new ForbiddenError('opening the live-send gate needs a signed-off jurisdiction policy first (outreach jurisdiction set)');
  }
  env.db.transaction(() => {
    const now = env.now();
    const row = env.db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(ctx.workspaceId);
    const settings = { ...(JSON.parse(row?.settings ?? '{}') as Record<string, unknown>), sendGate: gate };
    env.db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), ctx.workspaceId);
    audit(env.db, ctx, now, 'workspace', ctx.workspaceId, 'send_gate_changed', { gate, reason });
  });
}
