/**
 * Separate registry databases that share one local data.db.
 *
 * Before installs keyed folders by dbId, a team install of a database whose
 * label matched one of the installer's own ("LinkedIn Outreach v2") reused the
 * installer's folder: two Turso databases, one file. Each app then reads the
 * other database's rows.
 *
 * Rules (conservative — never guess with data):
 * - Only records with DIFFERENT cloud databases (tursoShortName) are split.
 *   Same tursoShortName = duplicate rows for one database; left alone.
 * - The oldest record keeps the folder (it was there first; later installs
 *   are the ones that collided).
 * - A record only moves if it is a replica: its rows live in Turso and are
 *   pulled fresh into the new folder. Legacy/job records are reported, not moved.
 * - migrations/ is copied so the moved database keeps its schema history.
 */
import { existsSync, promises as fs } from "fs";
import path from "path";
import {
  findRegistryLocalPathCollisions,
  type DatabaseRecord,
  type DatabasesRegistryFile,
} from "./DatabaseRegistryService.js";
import { workspaceRegistryDbPath } from "./resolveRegistryDbPath.js";

export interface RegistryCollisionMove {
  dbId: string;
  from: string;
  to: string;
  keptBy: string;
}

export interface RegistryCollisionPlan {
  moves: RegistryCollisionMove[];
  /** Collisions left alone, with why. */
  skipped: Array<{ localPath: string; dbIds: string[]; reason: string }>;
}

function slugDir(localPath: string): string | null {
  const m = /[\\/]databases[\\/]([^\\/]+)[\\/]data\.db$/.exec(localPath);
  return m?.[1] ?? null;
}

/** Pure planner — no disk writes. */
export function planRegistryCollisionRepair(
  state: DatabasesRegistryFile,
  dataDir: string,
): RegistryCollisionPlan {
  const plan: RegistryCollisionPlan = { moves: [], skipped: [] };
  for (const [localPath, dbIds] of findRegistryLocalPathCollisions(state)) {
    const records = dbIds
      .map((id) => state.databases[id])
      .filter((r): r is DatabaseRecord => Boolean(r))
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const slug = slugDir(localPath);
    if (!slug) {
      plan.skipped.push({ localPath, dbIds, reason: "not a workspace database folder" });
      continue;
    }
    const keeper = records[0]!;
    for (const record of records.slice(1)) {
      if (record.tursoShortName === keeper.tursoShortName) {
        plan.skipped.push({ localPath, dbIds: [keeper.dbId, record.dbId], reason: "same cloud database (duplicate record)" });
        continue;
      }
      if (record.syncMode !== "replica" || record.ownerJobId) {
        plan.skipped.push({ localPath, dbIds: [keeper.dbId, record.dbId], reason: "not a replica — rows can't be re-pulled safely" });
        continue;
      }
      plan.moves.push({
        dbId: record.dbId,
        from: localPath,
        to: workspaceRegistryDbPath(`${slug}-${record.dbId.replace(/^db-/, "")}`, dataDir),
        keptBy: keeper.dbId,
      });
    }
  }
  return plan;
}

/** Point every app data source for a moved dbId at its new file. */
async function rewriteAppDataSources(appsRoot: string, moves: RegistryCollisionMove[]): Promise<number> {
  const byId = new Map(moves.map((m) => [m.dbId, m.to]));
  let rewritten = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(appsRoot);
  } catch {
    return 0;
  }
  for (const appId of entries) {
    const file = path.join(appsRoot, appId, "data-sources.json");
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    let parsed: { sources?: Array<{ dbId?: string; dbPath?: string }> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    let changed = false;
    for (const source of parsed.sources ?? []) {
      const to = source.dbId ? byId.get(source.dbId) : undefined;
      if (to && source.dbPath !== to) {
        source.dbPath = to;
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
      rewritten += 1;
    }
  }
  return rewritten;
}

/** Apply the plan: new folder (+ migrations), registry path, app data sources. */
export async function repairRegistryPathCollisions(options?: {
  dryRun?: boolean;
}): Promise<RegistryCollisionPlan & { appsRewritten: number }> {
  const { initializeDatabaseRegistry } = await import("./DatabaseRegistryService.js");
  const { getPaprDataDir, getPaprAppsRoot } = await import("../../core/utils/paprRoot.js");
  const registry = await initializeDatabaseRegistry();
  const state: DatabasesRegistryFile = { version: 1, databases: {} };
  for (const record of registry.listActive()) state.databases[record.dbId] = record;
  const plan = planRegistryCollisionRepair(state, getPaprDataDir());
  // Only move a database whose cloud copy holds its rows. If writes only ever
  // reached the shared file, moving it would show its app empty — leave it
  // for a human (the rows are still in the shared file / keeper's cloud DB).
  const { countRemoteUserRows } = await import("./tursoReplica/tursoReplicaProvision.js");
  const verified: RegistryCollisionMove[] = [];
  for (const move of plan.moves) {
    const remoteRows = await countRemoteUserRows(state.databases[move.dbId]!).catch(() => -1);
    if (remoteRows > 0) {
      verified.push(move);
    } else {
      plan.skipped.push({
        localPath: move.from,
        dbIds: [move.keptBy, move.dbId],
        reason:
          remoteRows === 0
            ? `cloud copy of ${move.dbId} is empty — moving would show its app empty`
            : `couldn't check cloud copy of ${move.dbId} (offline)`,
      });
    }
  }
  plan.moves = verified;
  if (options?.dryRun || plan.moves.length === 0) {
    for (const skip of plan.skipped) {
      console.warn(`[DatabaseRegistry] Left shared file ${skip.localPath} (${skip.dbIds.join(", ")}): ${skip.reason}`);
    }
    return { ...plan, appsRewritten: 0 };
  }

  for (const move of plan.moves) {
    const fromMigrations = path.join(path.dirname(move.from), "migrations");
    const toDir = path.dirname(move.to);
    await fs.mkdir(toDir, { recursive: true });
    if (existsSync(fromMigrations) && !existsSync(path.join(toDir, "migrations"))) {
      await fs.cp(fromMigrations, path.join(toDir, "migrations"), { recursive: true });
    }
    // No data.db yet: the replica engine bootstraps it from this dbId's own
    // Turso database on first open.
    await registry.updateLocalPath(move.dbId, move.to);
    console.warn(
      `[DatabaseRegistry] Separated ${move.dbId} from ${move.keptBy}: ${move.from} → ${move.to}`,
    );
  }
  const appsRewritten = await rewriteAppDataSources(getPaprAppsRoot(), plan.moves);
  for (const skip of plan.skipped) {
    console.warn(`[DatabaseRegistry] Left shared file ${skip.localPath} (${skip.dbIds.join(", ")}): ${skip.reason}`);
  }
  return { ...plan, appsRewritten };
}
