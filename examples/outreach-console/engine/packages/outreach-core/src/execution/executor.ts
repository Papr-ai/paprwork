import { ulid } from '@splitin/outreach-contracts';
import { loadAccount, workerActor } from './actions-repo';
import { invokeProvider } from './invoke';
import { claimActions, preflight } from './preflight';
import { reconcileUncertain, sweepExpiredLeases, type ReconcileReport, type SweepReport } from './recovery';
import { recordResult } from './results';
import { resolveConfig, type ExecutionDeps } from './types';

export interface ExecuteReport {
  readonly claimed: number;
  readonly executed: number;
  readonly stopped: number;
  readonly lost: number;
}

/**
 * One executor pass: claim due actions, then for each run preflight (commits `executing`), call the
 * provider outside any transaction, and record the result. Repeats until nothing is due or `maxActions`.
 */
export async function executeDue(deps: ExecutionDeps, maxActions = 500): Promise<ExecuteReport> {
  const config = resolveConfig(deps);
  const traceId = ulid();
  const actor = workerActor(deps.workerId, traceId);
  let claimedTotal = 0;
  let executed = 0;
  let stopped = 0;
  let lost = 0;

  while (claimedTotal < maxActions) {
    const ids = claimActions(deps, actor, Math.min(config.claimBatch, maxActions - claimedTotal));
    if (ids.length === 0) break;
    claimedTotal += ids.length;
    for (const id of ids) {
      deps.hooks?.afterClaim?.(id);
      const outcome = preflight(deps, id, actor);
      if (outcome.kind === 'lost') {
        lost += 1;
        continue;
      }
      if (outcome.kind === 'stopped') {
        stopped += 1;
        continue;
      }
      deps.hooks?.afterPreflight?.(id);
      const account = loadAccount(deps.db, outcome.action.provider_account_id);
      const adapter = account ? (deps.adapters.get(account.provider) ?? null) : null;
      const result = await invokeProvider(deps, outcome.action, account, adapter, traceId);
      deps.hooks?.beforeResult?.(id);
      recordResult(deps, id, outcome.attemptId, result, actor);
      if (outcome.action.kind === 'manual.task' && deps.manual) {
        await announceManualTask(deps, outcome.action.id);
      }
      executed += 1;
    }
  }
  return { claimed: claimedTotal, executed, stopped, lost };
}

async function announceManualTask(deps: ExecutionDeps, actionId: string): Promise<void> {
  const task = deps.db
    .prepare('SELECT id, channel, target_url, draft_text, workspace_id FROM manual_tasks WHERE action_id = ?')
    .get<{ id: string; channel: string; target_url: string | null; draft_text: string; workspace_id: string }>(actionId);
  if (!task || !deps.manual) return;
  try {
    const ctx = {
      workspaceId: task.workspace_id,
      account: { id: 'manual', provider: 'manual', externalAccountId: 'manual', sender: { name: '', address: '' } },
      secretRef: '',
      secrets: deps.secrets,
      traceId: ulid(),
      signal: AbortSignal.timeout(resolveConfig(deps).providerTimeoutMs),
      now: deps.now,
    };
    await deps.manual.prepare(ctx, {
      taskId: task.id,
      channel: task.channel,
      draft: task.draft_text,
      ...(task.target_url ? { targetUrl: task.target_url } : {}),
    });
  } catch {
    // Announcing is best effort; the task already exists and is visible in the queue.
  }
}

export interface ExecutionPassReport {
  readonly sweep: SweepReport;
  readonly reconcile: ReconcileReport;
  readonly execute: ExecuteReport;
}

/** Sweep dead leases, reconcile uncertain actions, then execute due ones. */
export async function runExecutionPass(deps: ExecutionDeps): Promise<ExecutionPassReport> {
  const actor = workerActor(deps.workerId, ulid());
  const sweep = sweepExpiredLeases(deps, actor);
  const reconcile = await reconcileUncertain(deps, actor);
  const execute = await executeDue(deps);
  return { sweep, reconcile, execute };
}
