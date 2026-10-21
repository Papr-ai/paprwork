import { ulid, type ManualTaskProvider, type ProviderAdapter, type SecretResolver, type SqlDatabase } from '@splitin/outreach-contracts';
import { runExecutionPass, type ExecutionPassReport } from './execution/executor';
import { setKillSwitch, type KillSwitchScope } from './execution/kill-switches';
import { resolveReviewAction, type ReviewResolution } from './execution/review';
import type { ActionRow, CrashHooks, ExecutionConfig, ExecutionDeps, SendGate } from './execution/types';
import { readSendGate } from './domain/access';
import { NotFoundError, actorOf, audit, requireRole, type AuthContext, type Role } from './domain/auth';
import type { DomainEnv, UnsubscribeConfig } from './domain/env';
import { domainChecks, domainEffects, domainRatePolicy } from './domain/wiring';
import { checkDueAccountHealth } from './domain/health';
import { pollDueMailboxes } from './inbound/ingest';
import { processInboundEvents, type ProcessReport } from './inbound/process';

export interface EngineConfig {
  readonly db: SqlDatabase;
  readonly adapters: readonly ProviderAdapter[];
  readonly secrets: SecretResolver;
  readonly workerId: string;
  /**
   * Defaults to the workspace's audited setting (see setSendGate), which itself defaults to an empty
   * allowlist: nothing is emailed until an admin opens the gate.
   */
  readonly sendGate?: SendGate;
  readonly unsubscribe?: UnsubscribeConfig;
  readonly now?: () => number;
  readonly execution?: Partial<ExecutionConfig>;
  readonly manual?: ManualTaskProvider;
  readonly hooks?: CrashHooks;
  readonly random?: () => number;
  /** How often each mailbox is polled as a webhook fallback (default 5 minutes). */
  readonly pollIntervalMs?: number;
  /** How often each account's health is re-checked with its provider (default 15 minutes, §6.5). */
  readonly healthIntervalMs?: number;
}

export interface WorkerPassReport extends ExecutionPassReport {
  readonly health: { readonly checked: number; readonly changed: number };
  readonly polled: number;
  readonly inbound: ProcessReport;
}

export interface Engine extends DomainEnv {
  readonly exec: ExecutionDeps;
  /**
   * One worker pass: re-check due account health, poll due mailboxes, apply inbound events (so replies stop sequences BEFORE the next
   * send), then sweep leases, reconcile and execute due actions. Idempotent and safe to run concurrently.
   */
  runOnce(): Promise<WorkerPassReport>;
}

export function createEngine(config: EngineConfig): Engine {
  const now = config.now ?? Date.now;
  const adapters = new Map(config.adapters.map((adapter) => [adapter.name, adapter]));
  const holder: { env?: DomainEnv } = {};
  const exec: ExecutionDeps = {
    db: config.db,
    adapters,
    secrets: config.secrets,
    now,
    workerId: config.workerId,
    sendGate: config.sendGate ?? readSendGate,
    checks: domainChecks(),
    ratePolicy: domainRatePolicy,
    // Effects need the domain env, which needs exec: resolve lazily.
    effects: {
      onSucceeded: (...args) => holder.env && domainEffects(holder.env).onSucceeded?.(...args),
      onFailed: (...args) => holder.env && domainEffects(holder.env).onFailed?.(...args),
      onCancelled: (...args) => holder.env && domainEffects(holder.env).onCancelled?.(...args),
      onErrorEffects: (...args) => holder.env && domainEffects(holder.env).onErrorEffects?.(...args),
    },
    ...(config.execution ? { config: config.execution } : {}),
    ...(config.manual ? { manual: config.manual } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(config.random ? { random: config.random } : {}),
  };
  const env: DomainEnv = { db: config.db, now, adapters, exec, ...(config.unsubscribe ? { unsubscribe: config.unsubscribe } : {}) };
  holder.env = env;
  const pollIntervalMs = config.pollIntervalMs ?? 5 * 60_000;
  const healthIntervalMs = config.healthIntervalMs ?? 15 * 60_000;
  return {
    ...env,
    exec,
    runOnce: async () => {
      // Health first: an account that recovered (or broke) since the last pass is treated accordingly now.
      const health = await checkDueAccountHealth(env, healthIntervalMs);
      const polled = await pollDueMailboxes(env, pollIntervalMs);
      const inbound = processInboundEvents(env);
      return { health, polled, inbound, ...(await runExecutionPass(exec)) };
    },
  };
}

/** Creates a workspace and its first admin. The only operation that needs no existing principal. */
export function bootstrapWorkspace(db: SqlDatabase, input: { workspaceId: string; name: string; adminRef: string; adminName: string }, now = Date.now()): string {
  return db.transaction(() => {
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)').run(input.workspaceId, input.name, now);
    const principalId = ulid(now);
    const roles: Role[] = ['admin'];
    db.prepare('INSERT INTO principals (id, workspace_id, external_ref, display_name, roles) VALUES (?,?,?,?,?)')
      .run(principalId, input.workspaceId, input.adminRef, input.adminName, JSON.stringify(roles));
    audit(db, { workspaceId: input.workspaceId, principalId: 'system', roles: ['admin'], source: 'system', traceId: 'bootstrap' }, now, 'workspace', input.workspaceId, 'bootstrapped', { adminRef: input.adminRef });
    return principalId;
  });
}

export function setKillSwitchAs(env: DomainEnv, ctx: AuthContext, input: { scope: KillSwitchScope; targetId?: string; engaged: boolean; reason: string }): void {
  // Anyone who can operate may stop sending; only approvers may resume (BUILD_PLAN.md §9.4).
  requireRole(ctx, input.engaged ? 'operator' : 'approver');
  if (input.scope === 'global') requireRole(ctx, 'admin');
  env.db.transaction(() =>
    setKillSwitch(env.db, { workspaceId: ctx.workspaceId, scope: input.scope, targetId: input.targetId ?? '*', engaged: input.engaged, reason: input.reason }, actorOf(ctx), env.now()),
  );
}

export function listReview(env: DomainEnv, ctx: AuthContext): ActionRow[] {
  requireRole(ctx, 'viewer');
  return env.db.prepare(`SELECT * FROM scheduled_actions WHERE workspace_id = ? AND state = 'review' ORDER BY updated_at`).all<ActionRow>(ctx.workspaceId);
}

export function resolveReview(env: DomainEnv, ctx: AuthContext, actionId: string, resolution: ReviewResolution): void {
  requireRole(ctx, 'approver');
  const owned = env.db.prepare('SELECT 1 FROM scheduled_actions WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, actionId);
  if (!owned) throw new NotFoundError(`action ${actionId}`);
  resolveReviewAction(env.exec, actionId, resolution, actorOf(ctx));
}

export interface CampaignSummary {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly status: string;
  readonly created_at: number;
}

export function listCampaigns(env: DomainEnv, ctx: AuthContext): CampaignSummary[] {
  requireRole(ctx, 'viewer');
  return env.db.prepare('SELECT id, name, purpose, status, created_at FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC').all<CampaignSummary>(ctx.workspaceId);
}

export interface UpcomingAction {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly dueAt: number;
  readonly recipient: string | null;
  readonly subject: string | null;
  readonly campaignId: string | null;
  readonly campaignName: string | null;
  /** Why it is waiting, if it is (window, approval, budget, kill switch, pause). */
  readonly waitingOn: string | null;
}

/** What will leave the building in the next `hours`, including what is held and why. Bodies are never returned. */
export function listUpcoming(env: DomainEnv, ctx: AuthContext, hours = 24, limit = 200): UpcomingAction[] {
  requireRole(ctx, 'viewer');
  const until = env.now() + Math.min(Math.max(hours, 1), 168) * 3_600_000;
  const rows = env.db
    .prepare(
      `SELECT a.id, a.kind, a.state, a.due_at, a.recipient_norm, a.payload, a.campaign_id, a.state_reason, c.name AS campaign_name
       FROM scheduled_actions a LEFT JOIN campaigns c ON c.id = a.campaign_id
       WHERE a.workspace_id = ? AND a.state IN ('scheduled','awaiting_approval','claimed','executing') AND a.due_at <= ?
       ORDER BY a.due_at, a.id LIMIT ?`,
    )
    .all<{ id: string; kind: string; state: string; due_at: number; recipient_norm: string | null; payload: string; campaign_id: string | null; state_reason: string | null; campaign_name: string | null }>(ctx.workspaceId, until, Math.min(limit, 1000));
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as { subject?: string; title?: string; channel?: string };
    return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    dueAt: row.due_at,
    recipient: row.recipient_norm,
    subject: payload.subject ?? payload.title ?? (payload.channel ? `${payload.channel} task` : null),
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    waitingOn: row.state === 'awaiting_approval' ? 'approval' : row.state_reason,
    };
  });
}

export interface CampaignStatus {
  readonly campaignId: string;
  readonly status: string;
  readonly enrollments: Record<string, number>;
  readonly actions: Record<string, number>;
  readonly openTasks: number;
}

export function campaignStatus(env: DomainEnv, ctx: AuthContext, campaignId: string): CampaignStatus {
  requireRole(ctx, 'viewer');
  const campaign = env.db.prepare('SELECT status FROM campaigns WHERE workspace_id = ? AND id = ?').get<{ status: string }>(ctx.workspaceId, campaignId);
  if (!campaign) throw new NotFoundError(`campaign ${campaignId}`);
  const count = (sql: string) =>
    Object.fromEntries(env.db.prepare(sql).all<{ k: string; n: number }>(ctx.workspaceId, campaignId).map((row) => [row.k, row.n]));
  return {
    campaignId,
    status: campaign.status,
    enrollments: count('SELECT status AS k, COUNT(*) AS n FROM enrollments WHERE workspace_id = ? AND campaign_id = ? GROUP BY status'),
    actions: count('SELECT state AS k, COUNT(*) AS n FROM scheduled_actions WHERE workspace_id = ? AND campaign_id = ? GROUP BY state'),
    openTasks:
      env.db
        .prepare(`SELECT COUNT(*) AS n FROM manual_tasks t JOIN scheduled_actions a ON a.id = t.action_id WHERE t.workspace_id = ? AND a.campaign_id = ? AND t.status = 'open'`)
        .get<{ n: number }>(ctx.workspaceId, campaignId)?.n ?? 0,
  };
}
