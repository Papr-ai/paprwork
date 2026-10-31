import { z } from 'zod';
import { digestCanonical, ulid } from '@splitin/outreach-contracts';
import { ConflictError, NotFoundError, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';

export type PreparedKind = 'campaign.activate' | 'import.commit' | 'campaign.pause' | 'manual.done';
export interface PreparedPayload {
  readonly kind: PreparedKind;
  readonly targetId: string;
  readonly expectedHash?: string;
  readonly reason?: string;
  readonly outcome?: 'done' | 'skipped';
  readonly preview?: unknown;
}
const PreparedPayloadSchema = z.object({
  kind: z.enum(['campaign.activate', 'import.commit', 'campaign.pause', 'manual.done']),
  targetId: z.string().min(1).max(200),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reason: z.string().max(500).optional(),
  outcome: z.enum(['done', 'skipped']).optional(),
  preview: z.unknown().optional(),
}).strict().refine((payload) => !['campaign.activate', 'import.commit'].includes(payload.kind) || payload.expectedHash !== undefined, 'expected hash required')
  .refine((payload) => payload.kind !== 'manual.done' || payload.outcome !== undefined, 'manual outcome required');
interface PreparedRow {
  id: string;
  payload: string;
  operation_hash: string;
  expires_at: number;
  committed_at: number | null;
}
export interface PreparedOperation {
  readonly operationId: string;
  readonly operationHash: string;
  readonly expiresAt: number;
}

/** Durable, caller-bound envelope; the underlying domain operation still validates its own state. */
export function prepareOperation(env: DomainEnv, ctx: AuthContext, payload: PreparedPayload): PreparedOperation {
  requireRole(ctx, 'operator');
  PreparedPayloadSchema.parse(payload);
  return env.db.transaction(() => {
    const now = env.now();
    const operationId = ulid(now);
    const expiresAt = now + 15 * 60_000;
    const operationHash = digestCanonical({ operationId, workspaceId: ctx.workspaceId, principalId: ctx.principalId, payload, expiresAt });
    env.db.prepare(`INSERT INTO prepared_operations (id, workspace_id, principal_id, payload, operation_hash, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(operationId, ctx.workspaceId, ctx.principalId, JSON.stringify(payload), operationHash, expiresAt, now);
    audit(env.db, ctx, now, 'prepared_operation', operationId, 'prepared', { kind: payload.kind, targetId: payload.targetId, operationHash });
    return { operationId, operationHash, expiresAt };
  });
}

/** Read the exact stored operation for a host confirmation; never accept a replacement preview from tool input. */
export function inspectOperation(env: DomainEnv, ctx: AuthContext, input: { operationId: string; operationHash: string }): PreparedPayload {
  requireRole(ctx, 'operator');
  const row = env.db.prepare('SELECT * FROM prepared_operations WHERE id = ? AND workspace_id = ? AND principal_id = ?')
    .get<PreparedRow>(input.operationId, ctx.workspaceId, ctx.principalId);
  if (!row) throw new NotFoundError('prepared operation');
  if (row.committed_at !== null) throw new ConflictError('operation already committed');
  if (env.now() >= row.expires_at) throw new ConflictError('operation expired; prepare again');
  if (input.operationHash !== row.operation_hash) throw new ConflictError('operation hash mismatch');
  const payload = PreparedPayloadSchema.parse(JSON.parse(row.payload));
  const digest = digestCanonical({ operationId: row.id, workspaceId: ctx.workspaceId, principalId: ctx.principalId, payload, expiresAt: row.expires_at });
  if (digest !== row.operation_hash) throw new ConflictError('prepared operation integrity mismatch; prepare again');
  return payload;
}

/** Hash possession is not human consent. A host must obtain consent before invoking this service. */
export function commitOperation<T>(env: DomainEnv, ctx: AuthContext, input: { operationId: string; operationHash: string }, apply: (payload: PreparedPayload) => T): T {
  requireRole(ctx, 'operator');
  return env.db.transaction(() => {
    const payload = inspectOperation(env, ctx, input);
    const result = apply(payload);
    env.db.prepare('UPDATE prepared_operations SET committed_at = ? WHERE id = ?').run(env.now(), input.operationId);
    audit(env.db, ctx, env.now(), 'prepared_operation', input.operationId, 'committed', { kind: payload.kind, targetId: payload.targetId });
    return result;
  });
}
