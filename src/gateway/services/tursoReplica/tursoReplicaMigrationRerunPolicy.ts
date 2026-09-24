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
 * Policy. A migration absent from a READABLE ledger is pending and runs, as
 * before. Every other case is verified first, and a migration whose schema
 * cannot be confirmed is re-applied only if it is safe to re-run
 * (migrationRerunSafety: additive / idempotent statements only). A destructive
 * migration is refused and reported instead: drift left for a human is
 * recoverable, a dropped table is not.
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
}

export type RefusalReason = "recorded_unverified" | "unknown_ledger";

export type ReplicaMigrationDecision =
  | { action: "apply"; reason: "pending" | "reapply_additive" | "unknown_ledger_additive" }
  | { action: "skip"; reason: "applied" | "schema_present" }
  | { action: "refuse"; reason: RefusalReason };

/** Only a pending migration on a readable ledger runs without verifying first. */
export function replicaMigrationNeedsVerification(
  recorded: boolean,
  ledgerReadable: boolean,
): boolean {
  return recorded || !ledgerReadable;
}

export function decideReplicaMigration(
  facts: ReplicaMigrationFacts,
): ReplicaMigrationDecision {
  const { recorded, ledgerReadable, satisfied, rerunSafe } = facts;
  if (!recorded && ledgerReadable) {
    return { action: "apply", reason: "pending" };
  }
  if (satisfied === true) {
    return { action: "skip", reason: recorded ? "applied" : "schema_present" };
  }
  if (rerunSafe) {
    return {
      action: "apply",
      reason: recorded ? "reapply_additive" : "unknown_ledger_additive",
    };
  }
  return {
    action: "refuse",
    reason: recorded ? "recorded_unverified" : "unknown_ledger",
  };
}

export function describeRefusedMigration(
  migrationId: string,
  dbLabel: string,
  reason: RefusalReason,
  hazards: readonly string[],
): string {
  const why =
    reason === "recorded_unverified"
      ? "it is recorded as applied, but its schema could not be confirmed on the replica"
      : "the migration ledger could not be read, so there is no way to tell whether it already ran";
  const next =
    reason === "recorded_unverified"
      ? "Repair the schema with a NEW additive migration (CREATE TABLE IF NOT EXISTS, " +
        "ALTER TABLE ... ADD COLUMN, INSERT OR IGNORE)."
      : "It will be decided on a later run, once the ledger can be read.";
  return (
    `[TursoReplica] NOT re-running ${migrationId} on ${dbLabel}: ${why}, and ` +
    `running it again would drop, move or overwrite rows (${hazards.join("; ")}). ` +
    `Nothing was changed. ${next}`
  );
}
