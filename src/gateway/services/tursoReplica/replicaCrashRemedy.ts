/**
 * Choose a remedy for a sync-engine abort.
 *
 * The standing policy — reset the sync sidecars, retry once, park on the third strike —
 * is correct for a wedge whose cause lives in `-wal`/`-info`. It is wrong for a defect
 * inside `data.db`, in three separate ways: the reset *preserves* data.db by design, so
 * it cannot reach the cause; the retry therefore aborts a second time; and three strikes
 * means up to six process aborts per episode, each one a crash report.
 *
 * Rather than guess from the panic text, ask the file. Two different panics live in
 * `indexbtree_seek_internal` and the stderr tail does not reliably tell us which fired,
 * but {@link inspectReplicaEngineTables} reads the shape the engine *requires* of its own
 * bookkeeping tables — so a defect it finds after an abort is positive evidence about the
 * cause. That is what reaches the shape the pre-open precondition cannot: the table is
 * created from remote pages during the pull that then aborts on it, so it is absent or
 * healthy before the open and malformed only afterwards.
 *
 * The evidence is deliberately one-directional. Finding a defect tells us the reset
 * cannot help; *not* finding one tells us nothing about whether the sidecars are at
 * fault, so absence keeps the default. Calling a sidecar wedge a data defect would
 * delete a recovery that works, while the reverse only wastes the attempts we already
 * spend today.
 */

import {
  inspectReplicaEngineTables,
  describeReplicaEngineTableDefects,
  type ReplicaEngineTableDefect,
} from "./replicaEngineTableGuard.js";

export type ReplicaCrashRemedy =
  /** Cause may be in the sidecars: reset them (data.db is preserved) and retry. */
  | { kind: "reset_sidecars" }
  /** An engine table is malformed in data.db: drop it so the engine rebuilds it. */
  | { kind: "repair_engine_tables"; defects: string }
  /**
   * The malformed table came back after a repair. Nothing local produced it, so the
   * remote is feeding it and every further attempt aborts the worker again.
   */
  | { kind: "park"; defects: string; reason: string };

export interface ChooseReplicaCrashRemedyInput {
  localPath: string;
  /**
   * Whether this path has already had its engine tables dropped since the last healthy
   * operation. A defect present *after* a repair is the signal that distinguishes stale
   * local state (curable) from a remote that keeps sending the malformed shape (not).
   */
  repairAlreadyAttempted: boolean;
  /** Seam for tests; production reads the real file. */
  inspect?: (dbPath: string) => readonly ReplicaEngineTableDefect[];
}

export function chooseReplicaCrashRemedy(
  input: ChooseReplicaCrashRemedyInput,
): ReplicaCrashRemedy {
  const inspect = input.inspect ?? inspectReplicaEngineTables;

  let defects: readonly ReplicaEngineTableDefect[];
  try {
    defects = inspect(input.localPath);
  } catch {
    // An unreadable or contended file is not evidence either way — keep the default.
    return { kind: "reset_sidecars" };
  }

  if (defects.length === 0) {
    return { kind: "reset_sidecars" };
  }

  const described = describeReplicaEngineTableDefects(defects);
  if (input.repairAlreadyAttempted) {
    return {
      kind: "park",
      defects: described,
      reason:
        "a malformed engine table returned after being dropped, so the remote is " +
        "sending it rather than local state being stale",
    };
  }
  return { kind: "repair_engine_tables", defects: described };
}
