/**
 * Per-database publish hold (breaking migrations, Phase 1).
 *
 * A breaking migration (classifyMigrationSql) is applied to the local replica
 * right away but must NOT travel through sync: the engine drops renames and
 * half-applies table rebuilds (spikes S2/S3). While held:
 *  - uploads AND downloads for that replica are skipped (S2: a pull undoes renames);
 *  - local reads/writes keep working; every write is journaled in order;
 *  - at publish the migrations run on the cloud directly, the local copy is
 *    rebuilt from cloud and the journal is replayed (S3c).
 *
 * State lives on disk ({paprRoot}/data/publish-holds/) so a restart keeps the hold.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export interface HeldMigration {
  migrationId: string;
  sql: string;
  breaking: boolean;
  /** Where migrations/{id}.sql lives (cloud apply reuses the ledger-aware path). */
  migrationRoot?: string;
}

export interface ReplicaPublishHold {
  localPath: string;
  dbId?: string;
  appId?: string;
  since: string;
  migrations: HeldMigration[];
  /** Set once the replayed journal is on the cloud; a resumed publish must not replay again. */
  replayPushedAt?: string;
}

export interface HoldJournalEntry {
  sql: string;
  params?: unknown[];
  at: string;
}

let cache: Map<string, ReplicaPublishHold> | null = null;
const bypass = new Set<string>();
let cacheRoot = "";

function holdsDir(): string {
  return path.join(getPaprRoot(), "data", "publish-holds");
}

function keyFor(localPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(localPath)).digest("hex").slice(0, 24);
}

function holdFile(localPath: string): string {
  return path.join(holdsDir(), `${keyFor(localPath)}.json`);
}

function journalFile(localPath: string): string {
  return path.join(holdsDir(), `${keyFor(localPath)}.journal.jsonl`);
}

function load(): Map<string, ReplicaPublishHold> {
  const root = getPaprRoot();
  if (cache && cacheRoot === root) return cache;
  const next = new Map<string, ReplicaPublishHold>();
  try {
    for (const name of fs.readdirSync(holdsDir())) {
      if (!name.endsWith(".json")) continue;
      try {
        const hold = JSON.parse(fs.readFileSync(path.join(holdsDir(), name), "utf8")) as ReplicaPublishHold;
        if (hold?.localPath) next.set(path.resolve(hold.localPath), hold);
      } catch {
        // ignore a corrupt file; it will be rewritten on the next hold change
      }
    }
  } catch {
    // no holds dir yet
  }
  cache = next;
  cacheRoot = root;
  return next;
}

function persist(hold: ReplicaPublishHold): void {
  fs.mkdirSync(holdsDir(), { recursive: true });
  const file = holdFile(hold.localPath);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hold, null, 2));
  fs.renameSync(tmp, file);
}

/** On by default; PAPR_BREAKING_MIGRATION_HOLD=0|false|no|off is the kill switch. */
export function isBreakingMigrationHoldEnabled(): boolean {
  const raw = process.env.PAPR_BREAKING_MIGRATION_HOLD?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

export function getReplicaPublishHold(localPath: string): ReplicaPublishHold | undefined {
  return load().get(path.resolve(localPath));
}

export function isReplicaHeld(localPath: string): boolean {
  return getReplicaPublishHold(localPath) !== undefined;
}

/** syncKey is a dbId or a localPath (push scheduler keys). */
export function isSyncKeyHeld(syncKey: string): boolean {
  const resolved = path.resolve(syncKey);
  for (const hold of load().values()) {
    if (hold.dbId === syncKey || path.resolve(hold.localPath) === resolved) return true;
  }
  return false;
}

export function listReplicaPublishHolds(): ReplicaPublishHold[] {
  return [...load().values()];
}

/** Place or extend a hold. Migrations are kept in apply order; re-adding an id is a no-op. */
export function addMigrationToHold(input: {
  localPath: string;
  dbId?: string;
  appId?: string;
  migration: HeldMigration;
}): ReplicaPublishHold {
  const existing = getReplicaPublishHold(input.localPath);
  const hold: ReplicaPublishHold = existing ?? {
    localPath: path.resolve(input.localPath),
    dbId: input.dbId,
    appId: input.appId,
    since: new Date().toISOString(),
    migrations: [],
  };
  if (!hold.migrations.some((m) => m.migrationId === input.migration.migrationId)) {
    hold.migrations.push(input.migration);
  }
  hold.dbId ??= input.dbId;
  hold.appId ??= input.appId;
  persist(hold);
  load().set(path.resolve(hold.localPath), hold);
  return hold;
}

export function appendHoldJournal(
  localPath: string,
  statements: ReadonlyArray<{ sql: string; params?: unknown[] }>,
): void {
  // Publish replay runs under the bypass and must not re-journal itself.
  if (!isReplicaHeld(localPath) || statements.length === 0 || bypass.has(path.resolve(localPath))) return;
  const at = new Date().toISOString();
  const lines = statements.map((s) => JSON.stringify({ sql: s.sql, params: s.params, at }) + "\n").join("");
  fs.mkdirSync(holdsDir(), { recursive: true });
  fs.appendFileSync(journalFile(localPath), lines);
}

export function readHoldJournal(localPath: string): HoldJournalEntry[] {
  try {
    return fs
      .readFileSync(journalFile(localPath), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HoldJournalEntry);
  } catch {
    return [];
  }
}

/** Record that the held-period writes reached the cloud (publish crash-resume guard). */
export function markHoldReplayPushed(localPath: string): void {
  const hold = getReplicaPublishHold(localPath);
  if (!hold) return;
  hold.replayPushedAt = new Date().toISOString();
  persist(hold);
}

/** Lift the hold and drop its journal (publish step 6, after replay + push). */
export function releaseReplicaPublishHold(localPath: string): void {
  fs.rmSync(holdFile(localPath), { force: true });
  fs.rmSync(journalFile(localPath), { force: true });
  load().delete(path.resolve(localPath));
}

/** Publish procedure only: run fn with sync allowed for this held replica. */
export async function withHoldBypass<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(localPath);
  bypass.add(key);
  try {
    return await fn();
  } finally {
    bypass.delete(key);
  }
}

/** True when sync (push or pull) must be skipped for this replica. */
export function shouldSkipSyncForHold(localPath: string): boolean {
  return isReplicaHeld(localPath) && !bypass.has(path.resolve(localPath));
}

export function resetReplicaPublishHoldsForTests(): void {
  cache = null;
  cacheRoot = "";
  bypass.clear();
}
