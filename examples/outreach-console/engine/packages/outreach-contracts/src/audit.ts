/**
 * Append-only, hash-chained audit log (BUILD_PLAN.md §4.5). Every writer (core, importer, surfaces)
 * appends through this function inside its own transaction, so `BEGIN IMMEDIATE` serializes the chain.
 */
import { canonicalize, sha256Hex } from './crypto';
import type { SqlDatabase } from './sql';

export type AuditActorKind = 'principal' | 'worker' | 'provider' | 'system';

export interface AuditInput {
  readonly workspaceId: string;
  readonly at: number;
  readonly actorKind: AuditActorKind;
  readonly actorId: string;
  readonly source: string;
  readonly traceId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly action: string;
  readonly detail?: unknown;
}

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

interface AuditRow {
  seq: number;
  workspace_id: string;
  at: number;
  actor_kind: string;
  actor_id: string;
  source: string;
  trace_id: string;
  resource_kind: string;
  resource_id: string;
  action: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

function rowBody(row: Omit<AuditRow, 'seq' | 'prev_hash' | 'hash'>): string {
  return canonicalize(row);
}

function chainHash(prevHash: string, body: string): string {
  return sha256Hex(`${prevHash}\n${body}`);
}

export function appendAudit(db: SqlDatabase, input: AuditInput): string {
  const previous = db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get<{ hash: string }>();
  const prevHash = previous?.hash ?? AUDIT_GENESIS_HASH;
  const body = {
    workspace_id: input.workspaceId,
    at: input.at,
    actor_kind: input.actorKind,
    actor_id: input.actorId,
    source: input.source,
    trace_id: input.traceId,
    resource_kind: input.resourceKind,
    resource_id: input.resourceId,
    action: input.action,
    detail: canonicalize(input.detail ?? {}),
  };
  const hash = chainHash(prevHash, rowBody(body));
  db.prepare(
    `INSERT INTO audit_events (workspace_id, at, actor_kind, actor_id, source, trace_id, resource_kind,
       resource_id, action, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    body.workspace_id,
    body.at,
    body.actor_kind,
    body.actor_id,
    body.source,
    body.trace_id,
    body.resource_kind,
    body.resource_id,
    body.action,
    body.detail,
    prevHash,
    hash,
  );
  return hash;
}

export type AuditVerification = { ok: true; count: number } | { ok: false; count: number; brokenAtSeq: number };

/** Recomputes the whole chain. Any edited, deleted or reordered row breaks it. */
export function verifyAuditChain(db: SqlDatabase): AuditVerification {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all<AuditRow>();
  let prevHash = AUDIT_GENESIS_HASH;
  for (const row of rows) {
    const { seq, prev_hash, hash, ...rest } = row;
    if (prev_hash !== prevHash || chainHash(prevHash, rowBody(rest)) !== hash) {
      return { ok: false, count: rows.length, brokenAtSeq: seq };
    }
    prevHash = hash;
  }
  return { ok: true, count: rows.length };
}
