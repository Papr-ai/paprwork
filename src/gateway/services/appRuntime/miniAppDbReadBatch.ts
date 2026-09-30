/**
 * Mini-app /api/db/batch execution: group by database path, one replica worker slot
 * per path, parallel groups when paths differ.
 */

import type { AppDataSource } from "../appDataSources.js";
import type { DbRouter } from "./DbRouter.js";
import { isLocalDbReadable } from "./DbRouter.js";
import { shouldUseTursoReplicaForSource } from "../tursoReplica/tursoReplicaRouting.js";

export interface MiniAppReadBatchStatement {
  sourceId?: string;
  sql: string;
  params?: unknown[];
}

export interface PreparedMiniAppReadStatement {
  index: number;
  source: AppDataSource;
  sql: string;
  params?: unknown[];
}

export type MiniAppReadBatchRow = Record<string, unknown>;

/** Stable key for grouping statements that share one SQLite file / replica path. */
export function miniAppReadBatchGroupKey(source: AppDataSource): string {
  if (shouldUseTursoReplicaForSource(source)) {
    return `replica:${source.dbPath}`;
  }
  if (source.dbPath && isLocalDbReadable(source.dbPath)) {
    return `local:${source.dbPath}`;
  }
  const remoteId = source.dbId ?? source.alias ?? source.dbPath ?? "unknown";
  return `remote:${remoteId}`;
}

function groupPreparedStatements(
  prepared: PreparedMiniAppReadStatement[],
): Map<string, PreparedMiniAppReadStatement[]> {
  const groups = new Map<string, PreparedMiniAppReadStatement[]>();
  for (const entry of prepared) {
    const key = miniAppReadBatchGroupKey(entry.source);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return groups;
}

async function runReplicaGroup(
  dbRouter: DbRouter,
  appId: string,
  stmts: PreparedMiniAppReadStatement[],
  results: MiniAppReadBatchRow[],
): Promise<void> {
  const source = stmts[0].source;
  try {
    const batch = await dbRouter.queryReplicaBatch(
      appId,
      source,
      stmts.map((s) => ({ sql: s.sql, params: s.params })),
    );
    stmts.forEach((s, i) => {
      const part = batch[i];
      results[s.index] = {
        ok: true,
        ...part,
        source: source.alias,
      };
    });
  } catch (batchError) {
    console.warn(
      `[MiniAppReadBatch] Replica batch failed for ${source.alias ?? source.dbId} — ` +
        `falling back to per-statement reads: ${(batchError as Error).message.slice(0, 120)}`,
    );
    await Promise.all(
      stmts.map(async (s) => {
        try {
          const part = await dbRouter.query(appId, s.source, s.sql, s.params);
          results[s.index] = { ok: true, ...part, source: s.source.alias };
        } catch (err) {
          results[s.index] = { ok: false, error: (err as Error).message };
        }
      }),
    );
  }
}

async function runParallelQueryGroup(
  dbRouter: DbRouter,
  appId: string,
  stmts: PreparedMiniAppReadStatement[],
  results: MiniAppReadBatchRow[],
): Promise<void> {
  await Promise.all(
    stmts.map(async (s) => {
      try {
        const part = await dbRouter.query(appId, s.source, s.sql, s.params);
        results[s.index] = { ok: true, ...part, source: s.source.alias };
      } catch (err) {
        results[s.index] = { ok: false, error: (err as Error).message };
      }
    }),
  );
}

/**
 * Execute prepared statements preserving input order. Replica statements on the same
 * path use one worker `queryBatch` op; different paths run concurrently.
 */
export async function executeMiniAppReadBatch(
  dbRouter: DbRouter,
  appId: string,
  prepared: PreparedMiniAppReadStatement[],
  slotCount: number,
): Promise<MiniAppReadBatchRow[]> {
  const results: MiniAppReadBatchRow[] = new Array(slotCount);
  const groups = groupPreparedStatements(prepared);

  await Promise.all(
    [...groups.values()].map(async (stmts) => {
      const source = stmts[0].source;
      if (shouldUseTursoReplicaForSource(source)) {
        await runReplicaGroup(dbRouter, appId, stmts, results);
        return;
      }
      await runParallelQueryGroup(dbRouter, appId, stmts, results);
    }),
  );

  return results;
}
