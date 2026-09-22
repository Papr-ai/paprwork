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
 *
 * One panic is asked about directly, because for it the file cannot be the answer.
 * `PageCache` keeps no on-disk state, so an abort raised inside it says the engine's own
 * in-memory accounting disagrees with itself and nothing about `data.db` or the sidecars
 * — and a fresh process, which the retry already spawns, starts with a fresh cache. See
 * {@link classifyReplicaPanicSubsystem} for why the location is read and not the message.
 *
 * One panic is asked about *after* the file, and the ordering is load-bearing. An abort
 * in `btree.rs`/`pager.rs` usually describes pages no local remedy can change, so it
 * parks — but a malformed engine table produces that same abort, from the same module,
 * for a cause one `DROP` cures: the engine seeks a unique index the table does not have.
 * The two arrive with identical evidence in the location line, so deciding on the line
 * alone parks the curable case too, permanently, because a parked path is never retried
 * and the drop never runs. Reading the file first separates them.
 */

import {
  inspectReplicaEngineTablesDetailed,
  describeReplicaEngineTableDefects,
  type ReplicaEngineTableInspection,
} from "./replicaEngineTableGuard.js";
import type { ReplicaPanicSubsystem } from "./replicaPanicSubsystem.js";

export type ReplicaCrashRemedy =
  /** Cause may be in the sidecars: reset them (data.db is preserved) and retry. */
  | { kind: "reset_sidecars" }
  /**
   * The fault was process-local: drop the handle and let the next operation spawn a
   * fresh worker. Deliberately touches no file — the state that broke was in memory.
   */
  | { kind: "restart_worker"; subsystem: ReplicaPanicSubsystem }
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
  /**
   * The module the panic was raised in, when it is one whose state is process-local.
   * Null covers both "somewhere else" and "no location captured", which is why absence
   * falls through to asking the file rather than being read as a clean result.
   */
  panicSubsystem?: ReplicaPanicSubsystem | null;
  /**
   * Whether the abort was raised inside the modules that own `data.db`'s pages.
   *
   * The complement of {@link panicSubsystem}: that field names a fault a fresh process
   * cures, this one names a fault no local action cures. Both are read from the panic's
   * location line, so both are absent when the stderr ring was truncated, and absence
   * falls through to inspecting the file rather than being read either way.
   */
  panicInDurableStorage?: boolean;
  /** Seam for tests; production reads the real file. */
  inspect?: (dbPath: string) => ReplicaEngineTableInspection;
}

export function chooseReplicaCrashRemedy(
  input: ChooseReplicaCrashRemedyInput,
): ReplicaCrashRemedy {
  // Before the file is opened, and deliberately so: this panic is not evidence about the
  // file, and `repair_engine_tables` spends a one-shot budget — it sets
  // `repairAlreadyAttempted`, so the *next* abort parks. Repairing on an unrelated panic
  // would therefore park the first genuine table defect on sight.
  if (input.panicSubsystem) {
    return { kind: "restart_worker", subsystem: input.panicSubsystem };
  }

  // The file is read before the durable-storage park, and the ordering is the whole
  // point. A malformed engine table *is* a btree abort — the engine seeks the unique
  // index the table does not have, and `indexbtree_seek_internal` panics — so the two
  // conditions this function has to separate arrive with identical evidence in the
  // panic's location line. Parking on that line alone therefore parks the curable case
  // as well as the incurable one, and parking is permanent: the database is never
  // retried, so the drop that would have cured it never runs.
  //
  // Reading the file settles it, and the reading is one-directional in the same way the
  // rest of this function is. A *found* defect is positive evidence — this shape aborts
  // exactly here, and dropping the table is known to cure it — so it wins. Finding none
  // proves nothing about user-table pages, which this inspection does not read, so an
  // absence falls through to the park below rather than licensing a retry.
  const inspect = input.inspect ?? inspectReplicaEngineTablesDetailed;

  let inspection: ReplicaEngineTableInspection;
  try {
    inspection = inspect(input.localPath);
  } catch (error) {
    inspection = {
      status: "unreadable",
      reason: `inspection threw: ${(error as Error).message}`,
    };
  }

  if (inspection.status === "inspected" && inspection.defects.length > 0) {
    const described = describeReplicaEngineTableDefects(inspection.defects);
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

  // No defect this inspection can see, and the panic came from inside data.db's own
  // pages. Every remedy available here leaves those bytes where they are —
  // `reset_sidecars` preserves data.db by contract, and `repair_engine_tables` has
  // nothing to drop — so the retry lands on the same page and aborts again. Parking
  // costs one abort and says what actually cures it; falling through costs up to six
  // and arrives at the same place.
  if (input.panicInDurableStorage) {
    // Narrowed inline rather than through a boolean: `inspection.reason` only exists on
    // the unreadable arm, and a `const couldNotRead = ...` does not carry that narrowing.
    const detail =
      inspection.status === "unreadable"
        ? {
            defects: `data.db could not be inspected (${inspection.reason})`,
            cause:
              "the abort came from inside data.db's own pages and the file could not " +
              "be read to narrow it further, so no local remedy can be chosen with " +
              "confidence — ",
          }
        : {
            defects: "data.db page structure (abort raised in the btree/pager layer)",
            cause:
              "the abort came from inside data.db's own pages, which neither restarting " +
              "the worker nor resetting the sidecars can change — ",
          };
    return {
      kind: "park",
      defects: detail.defects,
      reason:
        detail.cause +
        "re-seed this replica from the remote (repair_cloud_sync with accept_cloud) " +
        "to clear it",
    };
  }

  // An unreadable file is not evidence either way for a panic raised anywhere else, so
  // the standing policy holds: a wedge in -wal/-info is the remaining likely cause.
  return { kind: "reset_sidecars" };
}
