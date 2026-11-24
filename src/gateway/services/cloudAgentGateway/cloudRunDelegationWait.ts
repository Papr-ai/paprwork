/**
 * A cloud run (iMessage, agent runs) ends when its turn ends: the caller sends whatever the
 * agent said last and closes. If that turn started a helper agent (delegate_task), the helper's
 * result used to wake a *new* turn outside the run, so its answer never reached the person and
 * its app edits were not pushed ("no run is active").
 *
 * Instead the run waits for helpers that report to this chat, then continues with one follow-up
 * turn inside the same run. The desktop keeps the old behaviour (SubAgentResponseTrigger).
 */
import type { JobRecord } from "../jobs/types.js";

const inlineChats = new Set<string>();

/** SubAgentResponseTrigger skips chats whose cloud run is handling the finish itself. */
export function isCloudRunAwaitingDelegations(chatId: string): boolean {
  return inlineChats.has(chatId);
}

export function markCloudRunAwaiting(chatId: string, on: boolean): void {
  if (on) inlineChats.add(chatId);
  else inlineChats.delete(chatId);
}

const ACTIVE = new Set(["pending", "running", "waiting_permission"]);

export function activeDelegationsForChat(jobs: JobRecord[], chatId: string): JobRecord[] {
  return jobs.filter(
    (j) => j.type === "subagent" && j.reportChatId === chatId && ACTIVE.has(j.status),
  );
}

export interface FinishedDelegation {
  id: string;
  outcome: "completed" | "failed";
}

/**
 * Wait until none of `ids` is active any more (or the deadline passes).
 * Returns the ones that finished; still-running ones are left out.
 */
export async function waitForDelegations(
  ids: string[],
  getJob: (id: string) => Promise<JobRecord | null>,
  opts: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<FinishedDelegation[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  const done = new Map<string, FinishedDelegation>();
  for (;;) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const job = await getJob(id);
      if (!job || !ACTIVE.has(job.status)) {
        done.set(id, { id, outcome: job?.status === "completed" ? "completed" : "failed" });
      }
    }
    if (done.size === ids.length || Date.now() >= deadline) break;
    await sleep(opts.pollMs ?? 2000);
  }
  return [...done.values()];
}

/** Max time a cloud run waits for helpers (the gateway's own run limit is 30 min). */
export const CLOUD_DELEGATION_WAIT_MS = 15 * 60 * 1000;
/** Follow-up turns per run, so a helper that starts another helper can't loop forever. */
export const CLOUD_MAX_FOLLOW_UPS = 3;
