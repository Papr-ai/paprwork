/**
 * The bash tool's hook into the resource governor: lease before a memory-heavy command starts, track every started
 * process tree, release and learn its peak when it exits, and hand back anything the watchdog did to it.
 */
import { getResourceGovernor, type Lease } from "./resourceGovernor.js";
import type { CommandCost } from "./commandCost.js";

export interface BashGovernorHandle {
  cost: CommandCost;
  /** Pass to the spawn call: registers the pid with the watchdog. */
  onSpawn: (pid: number | undefined) => void;
  /** Call once when the process has exited (success or failure). Returns a note for the agent, if any. */
  done: () => string | undefined;
}

export type BashAdmission = { ok: true; handle: BashGovernorHandle } | { ok: false; message: string; cost: CommandCost };

export async function admitBashCommand(command: string, owner: string | null, opts: { waitMs?: number } = {}): Promise<BashAdmission> {
  const gov = getResourceGovernor();
  const who = owner || "agent";
  let a;
  try {
    a = await gov.acquire(command, who, { waitMs: opts.waitMs });
  } catch {
    // The governor must never block a command because it failed itself.
    const cost = gov.classify(command);
    return { ok: true, handle: { cost, onSpawn: () => undefined, done: () => undefined } };
  }
  if (!a.ok) return { ok: false, message: a.message, cost: a.cost };
  const lease: Lease | null = a.lease;
  let pid: number | undefined;
  let finished = false;
  return {
    ok: true,
    handle: {
      cost: a.cost,
      onSpawn: (p) => {
        pid = p;
        // Light commands (grep, ls, git) are not worth a process scan each.
        if (a.cost.cls !== "light") gov.track(p, who, command, lease, a.cost);
      },
      done: () => {
        if (finished) return undefined;
        finished = true;
        gov.release(lease);
        return gov.finish(pid, lease);
      },
    },
  };
}
