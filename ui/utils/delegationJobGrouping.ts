import type { JobRecord, JobStatus } from "../hooks/useJobs";

const DELEGATION_NAME_PREFIX = /^Delegation:\s*(.+)$/i;

export function isDelegationRun(job: JobRecord): boolean {
  if (job.type !== "subagent") {
    return false;
  }
  if (job.delegatedBy) {
    return true;
  }
  return DELEGATION_NAME_PREFIX.test(job.name.trim());
}

export function delegationProfileName(job: JobRecord): string {
  const match = job.name.trim().match(DELEGATION_NAME_PREFIX);
  if (match?.[1]) {
    return match[1].trim();
  }
  if (job.subAgentId) {
    return job.subAgentId;
  }
  return job.name;
}

export function delegationGroupKey(job: JobRecord): string {
  if (job.subAgentId) {
    return `id:${job.subAgentId}`;
  }
  const match = job.name.trim().match(DELEGATION_NAME_PREFIX);
  if (match?.[1]) {
    return `name:${match[1].trim().toLowerCase()}`;
  }
  return `job:${job.id}`;
}

function runTimestamp(job: JobRecord): number {
  const raw = job.lastRunAt ?? job.updatedAt ?? job.createdAt;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function isActiveStatus(status: JobStatus): boolean {
  return status === "running" || status === "waiting_permission";
}

export interface DelegationRunGroup {
  key: string;
  profileName: string;
  runs: JobRecord[];
  totalRuns: number;
  failedCount: number;
  activeCount: number;
  lastRunAt?: string;
  hasActive: boolean;
}

export function buildDelegationRunGroups(
  jobs: JobRecord[],
  options?: { hideCompleted?: boolean },
): DelegationRunGroup[] {
  const hideCompleted = options?.hideCompleted ?? false;
  const byKey = new Map<string, JobRecord[]>();

  for (const job of jobs) {
    if (!isDelegationRun(job)) {
      continue;
    }
    if (hideCompleted && job.status === "completed") {
      continue;
    }
    const key = delegationGroupKey(job);
    const bucket = byKey.get(key) ?? [];
    bucket.push(job);
    byKey.set(key, bucket);
  }

  const groups: DelegationRunGroup[] = [];

  for (const [key, runs] of byKey.entries()) {
    const sortedRuns = [...runs].sort((a, b) => runTimestamp(b) - runTimestamp(a));
    const profileName = delegationProfileName(sortedRuns[0]!);
    const failedCount = sortedRuns.filter((run) => run.status === "failed").length;
    const activeCount = sortedRuns.filter((run) => isActiveStatus(run.status)).length;
    const lastRunAt = sortedRuns[0]?.lastRunAt ?? sortedRuns[0]?.updatedAt;

    groups.push({
      key,
      profileName,
      runs: sortedRuns,
      totalRuns: sortedRuns.length,
      failedCount,
      activeCount,
      lastRunAt,
      hasActive: activeCount > 0,
    });
  }

  return groups.sort((a, b) => {
    if (a.hasActive && !b.hasActive) return -1;
    if (!a.hasActive && b.hasActive) return 1;
    const aMs = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
    const bMs = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
    return bMs - aMs;
  });
}

export function formatDelegationGroupSummary(group: DelegationRunGroup): string {
  const parts = [`${group.totalRuns} run${group.totalRuns === 1 ? "" : "s"}`];
  if (group.failedCount > 0) {
    parts.push(`${group.failedCount} failed`);
  }
  if (group.activeCount > 0) {
    parts.push(`${group.activeCount} active`);
  }
  return parts.join(" · ");
}

export function delegationRunLabel(job: JobRecord, index: number, total: number): string {
  const runNumber = total - index;
  const when = job.lastRunAt ?? job.updatedAt;
  if (when) {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) {
      return `Run ${runNumber} · ${d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
  }
  return `Run ${runNumber}`;
}
