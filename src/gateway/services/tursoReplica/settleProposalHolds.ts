/**
 * Settle proposal holds: a teammate on the team's shared data applied schema
 * changes on this desktop only (replicaPublishHold purpose "proposal"). They
 * reach the shared cloud copy only when the publisher approves the proposal.
 *
 *   approved — every held migration is in the cloud ledger (the publisher ran
 *              them): rebuild from cloud, replay held-period writes, upload, release.
 *   rejected — the latest proposal carrying the held migrations was rejected:
 *              rebuild from cloud (old schema), replay the writes that still fit,
 *              report the ones that don't, quarantine the migration files, release.
 *   otherwise — still waiting (not proposed yet, or under review): keep the hold.
 *
 * Runs on startup, reconnect and the periodic pull tick.
 */

import * as path from "node:path";
import type { AppDataSource } from "../appDataSources.js";
import {
  holdPurpose,
  listReplicaPublishHolds,
  readHoldJournal,
  releaseReplicaPublishHold,
  withHoldBypass,
  type ReplicaPublishHold,
} from "./replicaPublishHold.js";

export type ProposalOutcome = "approved" | "rejected" | "pending";

export interface SettleDeps {
  /** Migration ids recorded in the shared cloud copy's ledger. */
  cloudAppliedIds(dbId: string): Promise<Set<string>>;
  /** Status of the newest sent proposal that carries any of these migration files, if any. */
  latestProposalStatus(dbId: string, migrationFiles: string[]): Promise<string | null>;
  rebuildLocalFromCloud(dbId: string): Promise<void>;
  /** Replay one write; throws when it no longer fits the schema. */
  replayOne(source: AppDataSource, statement: { sql: string; params?: unknown[] }): Promise<void>;
  push(source: AppDataSource): Promise<{ ok: boolean; error?: string }>;
  quarantineMigrations(hold: ReplicaPublishHold): Promise<void>;
}

export interface SettleResult {
  dbId: string;
  outcome: ProposalOutcome;
  replayed: number;
  /** Writes made during the hold that don't fit the cloud schema after a rejection. */
  dropped: Array<{ sql: string; error: string }>;
}

export async function decideProposalOutcome(hold: ReplicaPublishHold, deps: SettleDeps): Promise<ProposalOutcome> {
  if (!hold.dbId || hold.migrations.length === 0) return "pending";
  const ids = hold.migrations.map((m) => m.migrationId);
  const cloud = await deps.cloudAppliedIds(hold.dbId);
  if (ids.every((id) => cloud.has(id))) return "approved";
  const status = await deps.latestProposalStatus(hold.dbId, ids.map((id) => `${id}.sql`));
  return status === "rejected" ? "rejected" : "pending";
}

export async function settleProposalHold(
  hold: ReplicaPublishHold,
  deps: SettleDeps,
): Promise<SettleResult | null> {
  if (holdPurpose(hold) !== "proposal" || !hold.dbId) return null;
  const dbId = hold.dbId;
  const outcome = await decideProposalOutcome(hold, deps);
  if (outcome === "pending") return { dbId, outcome, replayed: 0, dropped: [] };

  const source: AppDataSource = {
    id: `proposal:${dbId}`,
    type: "sqlite",
    dbId,
    alias: "proposal",
    dbPath: hold.localPath,
    tables: [],
    linkedAt: hold.since,
  };
  return withHoldBypass(hold.localPath, async () => {
    const journal = readHoldJournal(hold.localPath);
    await deps.rebuildLocalFromCloud(dbId);
    let replayed = 0;
    const dropped: SettleResult["dropped"] = [];
    for (const entry of journal) {
      try {
        await deps.replayOne(source, { sql: entry.sql, params: entry.params });
        replayed++;
      } catch (error) {
        // Approved: the schema matches, so a failure is real — keep the hold and retry later.
        if (outcome === "approved") throw error;
        dropped.push({ sql: entry.sql, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (replayed > 0) {
      const pushed = await deps.push(source);
      if (!pushed.ok) throw new Error(`Upload after replay failed for ${dbId}: ${pushed.error ?? "push failed"}`);
    }
    if (outcome === "rejected") await deps.quarantineMigrations(hold);
    releaseReplicaPublishHold(hold.localPath);
    return { dbId, outcome, replayed, dropped };
  });
}

export async function settleProposalHolds(deps?: SettleDeps): Promise<SettleResult[]> {
  const holds = listReplicaPublishHolds().filter((h) => holdPurpose(h) === "proposal");
  if (holds.length === 0) return [];
  const { defaultSettleDeps } = await import("./settleProposalHoldsDeps.js");
  const d = deps ?? (await defaultSettleDeps());
  const results: SettleResult[] = [];
  for (const hold of holds) {
    try {
      const r = await settleProposalHold(hold, d);
      if (!r) continue;
      results.push(r);
      if (r.outcome !== "pending") {
        console.log(
          `[ProposalHold] ${r.dbId}: proposal ${r.outcome} — rebuilt from the shared copy, ` +
            `replayed ${r.replayed} write(s)` +
            (r.dropped.length ? `, ${r.dropped.length} no longer fit and were dropped` : ""),
        );
        for (const drop of r.dropped) console.warn(`[ProposalHold] ${r.dbId} dropped: ${drop.sql} (${drop.error})`);
      }
    } catch (error) {
      console.warn(
        `[ProposalHold] ${hold.dbId ?? path.basename(hold.localPath)}: settle failed, hold kept:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return results;
}
