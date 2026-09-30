/**
 * Coalesce rapid jobs:db-changed hub events per dbId/jobId so mini-apps do not repaint on every row write.
 */

import type { JobEvent } from "../../core/types/jobEvents.js";
import { getJobEventHub } from "./JobEventHub.js";

const COALESCE_MS = 400;

type PendingDbChange = {
  jobId?: string;
  dbId?: string;
  tables: Set<string>;
};

const pendingByKey = new Map<string, PendingDbChange>();
const timerByKey = new Map<string, ReturnType<typeof setTimeout>>();

function pendingKey(data: { jobId?: string; dbId?: string }): string {
  if (data.dbId) return `db:${data.dbId}`;
  if (data.jobId) return `job:${data.jobId}`;
  return "";
}

function flushPending(key: string): void {
  timerByKey.delete(key);
  const pending = pendingByKey.get(key);
  pendingByKey.delete(key);
  if (!pending) return;

  const hub = getJobEventHub();
  hub.publish({
    type: "jobs:db-changed",
    data: {
      ...(pending.jobId ? { jobId: pending.jobId } : {}),
      ...(pending.dbId ? { dbId: pending.dbId } : {}),
      tables: [...pending.tables],
    },
  } satisfies JobEvent);
}

/** Test-only: flush all pending coalesced events immediately. */
export function flushAllCoalescedDbChangedForTests(): void {
  for (const key of [...timerByKey.keys()]) {
    const timer = timerByKey.get(key);
    if (timer) clearTimeout(timer);
    flushPending(key);
  }
}

export function resetDbChangedCoalesceForTests(): void {
  for (const timer of timerByKey.values()) {
    clearTimeout(timer);
  }
  timerByKey.clear();
  pendingByKey.clear();
}

export function publishDbChangedCoalesced(
  target: string | { jobId?: string; dbId?: string; tables?: string[] },
  tables: string[] = [],
): void {
  const data =
    typeof target === "string"
      ? { jobId: target, tables }
      : {
          ...(target.jobId ? { jobId: target.jobId } : {}),
          ...(target.dbId ? { dbId: target.dbId } : {}),
          tables: target.tables ?? [],
        };

  if (!data.jobId && !data.dbId) {
    return;
  }

  const key = pendingKey(data);
  if (!key) return;

  let pending = pendingByKey.get(key);
  if (!pending) {
    pending = {
      jobId: data.jobId,
      dbId: data.dbId,
      tables: new Set<string>(),
    };
    pendingByKey.set(key, pending);
  }

  for (const table of data.tables) {
    if (table) pending.tables.add(table);
  }

  const existingTimer = timerByKey.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  timerByKey.set(
    key,
    setTimeout(() => {
      flushPending(key);
    }, COALESCE_MS),
  );
}
