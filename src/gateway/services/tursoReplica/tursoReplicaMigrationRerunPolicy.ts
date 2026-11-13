/**
 * When may the Plan A replica runner run a migration again?
 *
 * applyReplicaRegistryDatabaseMigrations executes before EVERY job run. It used
 * to apply any migration missing from `schema_migrations`, and to re-apply any
 * migration found there but not verifiable on the replica -- whatever the
 * migration did. On 2026-09-24 that emptied the live tables of a telemetry
 * database, in the replica and in Turso, through three gaps:
 *
 *  1. Two ledgers, one read. papr_db migration tools record in
 *     `_papr_schema_migrations`, which lives on the Turso primary and survives
 *     a replica reseed; `schema_migrations` rows are replica-local and do not.
 *     The runner read only `schema_migrations`, so a reseeded replica looked
 *     like a database that had never run its migrations.
 *  2. A failed ledger read became an empty set: "could not read" was treated
 *     as "nothing has run", so every migration was applied again.
 *  3. Drift repair re-applied recorded migrations blindly, including a
 *     copy-and-swap rebuild (CREATE t_v2; INSERT ... SELECT; DROP t; RENAME).
 *
 * Policy.
 *  - Recorded in either ledger: applied. Not re-verified. The schema change and
 *    its ledger row commit in one transaction and sync together, so a recorded
 *    migration ran. Re-checking one migration against today's schema also gives
 *    false alarms whenever a LATER migration rebuilt or dropped what it created
 *    (2026-11: Release Desk 0002 after 0003 rebuilt pull_requests, 821 warnings).
 *  - Absent from a READABLE ledger: pending, runs (unless the ledger is behind).
 *  - Ledger unreadable: verify; re-run only if safe to re-run
 *    (migrationRerunSafety: additive / idempotent statements only). A
 *    destructive migration is refused and reported instead: drift left for a
 *    human is recoverable, a dropped table is not.
 * Schema drift on a recorded migration is a diagnostics question
 * (papr_db_migration_parity), not something to guess at before every job run.
 */

export interface ReplicaMigrationFacts {
  /** Found in either ledger (`schema_migrations` or `_papr_schema_migrations`). */
  recorded: boolean;
  /** Both ledgers answered. A missing ledger table is an answer: a fresh database. */
  ledgerReadable: boolean;
  /** Verification on the replica handle; null when it was not needed. */
  satisfied: boolean | null;
  /** Every statement is additive or idempotent (migrationRerunSafety). */
  rerunSafe: boolean;
  /**
   * Pending only: a migration at or after this one is missing from the ledger
   * but its schema is already fully on the database. The ledger is behind the
   * real state, so "absent from the ledger" no longer means "never ran".
   */
  ledgerBehind?: boolean;
}

export type RefusalReason = "unknown_ledger" | "ledger_behind";

export type ReplicaMigrationDecision =
  | { action: "apply"; reason: "pending" | "unknown_ledger_additive" }
  | { action: "skip"; reason: "applied" | "schema_present" }
  | { action: "refuse"; reason: RefusalReason };

/** Only an unreadable ledger needs the schema checked: the ledger can't answer. */
export function replicaMigrationNeedsVerification(
  recorded: boolean,
  ledgerReadable: boolean,
): boolean {
  return !recorded && !ledgerReadable;
}

export function decideReplicaMigration(
  facts: ReplicaMigrationFacts,
): ReplicaMigrationDecision {
  const { recorded, ledgerReadable, satisfied, rerunSafe, ledgerBehind } = facts;
  if (recorded) {
    return { action: "skip", reason: "applied" };
  }
  if (ledgerReadable) {
    // Enrichment, 2026-10: ledger listed 0001-0004 while 0005-0014 had run.
    // Replaying a DELETE+INSERT seed over live rows broke the install.
    if (satisfied === true) {
      return { action: "skip", reason: "schema_present" };
    }
    if (ledgerBehind && !rerunSafe) {
      return { action: "refuse", reason: "ledger_behind" };
    }
    return { action: "apply", reason: "pending" };
  }
  if (satisfied === true) {
    return { action: "skip", reason: "schema_present" };
  }
  if (rerunSafe) {
    return { action: "apply", reason: "unknown_ledger_additive" };
  }
  return { action: "refuse", reason: "unknown_ledger" };
}

export function describeRefusedMigration(
  migrationId: string,
  dbLabel: string,
  reason: RefusalReason,
  hazards: readonly string[],
): string {
  const why =
    reason === "ledger_behind"
      ? "it is missing from the migration ledger, but later migrations are already on " +
        "the database, so the ledger is behind and this one most likely ran already"
      : "the migration ledger could not be read, so there is no way to tell whether it already ran";
  const next =
    reason === "ledger_behind"
      ? "Record it in the ledger without running it, or make the migration replay-safe " +
        "(INSERT OR IGNORE / ON CONFLICT DO NOTHING instead of DELETE + INSERT)."
      : "It will be decided on a later run, once the ledger can be read.";
  return (
    `[TursoReplica] NOT re-running ${migrationId} on ${dbLabel}: ${why}, and ` +
    `running it again would drop, move or overwrite rows (${hazards.join("; ")}). ` +
    `Nothing was changed. ${next}`
  );
}
