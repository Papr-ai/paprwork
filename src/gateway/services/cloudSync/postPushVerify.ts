/**
 * Post-push convergence checks (SYNC_CONTRACT §10, §12.1).
 * Git remote SHA + Turso table set, migrations, and spot row counts.
 */

import { createClient, type Client } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { resolveMigrationRootFromDbPath } from "../jobs/databaseMigrations.js";
import { listAppliedMigrationIdsReadOnly } from "../jobs/schemaMigrationsLedger.js";
import { migrationSatisfiedOnRemote } from "../jobs/jobMigrationLedgerSync.js";
import { shouldVerifyMigrationOnRemote } from "../jobs/migrationLedgerPolicy.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import {
  filterSyncableTables,
  listUserTables,
  openWritableLocalJobDb,
} from "../tursoSyncBridgeCore.js";
import { discoverTursoLinkedSources, linkedSourceSyncKey } from "../tursoLinkedSources.js";
import { jobTursoDatabaseName } from "../tursoDatabaseNaming.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import { isJobDbDirty, loadTursoSyncState } from "../tursoSyncState.js";
import { buildTursoSyncItemsReport } from "../tursoSyncStatus.js";
import { GitRunner } from "./gitRunner.js";

export type GitVerifyFn = (args: string[]) => Promise<string>;

export interface GitVerifyResult {
  ok: boolean;
  localHead: string;
  remoteHead: string;
  error?: string;
  /** App-scoped verify: git path under repo root (e.g. apps/{id}). */
  appPath?: string;
  localTreeSha?: string;
  remoteTreeSha?: string;
  /** True when repo HEAD diverges but app subtree still matches on remote. */
  workspaceHeadMismatch?: boolean;
}

export interface TursoSourceVerifyResult {
  alias: string;
  jobId: string;
  ok: boolean;
  error?: string;
  localTableCount?: number;
  remoteTableCount?: number;
}

export interface TursoVerifyResult {
  ok: boolean;
  sources: TursoSourceVerifyResult[];
  errors: string[];
}

export interface AppPushVerifyResult {
  ok: boolean;
  git: GitVerifyResult | null;
  turso: TursoVerifyResult;
  errors: string[];
  warnings: string[];
}

function listLocalAppliedMigrationIds(localDb: Database.Database): string[] {
  return listAppliedMigrationIdsReadOnly(localDb);
}

function resolveTursoDatabaseLabel(
  source: Awaited<ReturnType<typeof discoverTursoLinkedSources>>[number],
): string {
  const registry = getDatabaseRegistryService();
  if (source.dbId) {
    const record = registry.getById(source.dbId);
    if (record) {
      return record.tursoShortName;
    }
  }
  const byPath = registry.getByPath(source.dbPath);
  if (byPath) {
    return byPath.tursoShortName;
  }
  if (source.jobId) {
    return jobTursoDatabaseName(source.jobId);
  }
  return linkedSourceSyncKey(source);
}

async function countRemoteTableRows(
  remote: Client,
  tableName: string,
): Promise<number> {
  const quoted = `"${tableName.replace(/"/g, '""')}"`;
  const result = await remote.execute(`SELECT COUNT(*) AS count FROM ${quoted}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function verifySourceRowCounts(
  localDb: Database.Database,
  remote: Client,
  tableNames: readonly string[],
): Promise<string | null> {
  for (const tableName of tableNames) {
    const quoted = `"${tableName.replace(/"/g, '""')}"`;
    const localCount = (
      localDb.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get() as {
        count: number;
      }
    ).count;
    const remoteCount = await countRemoteTableRows(remote, tableName);
    if (localCount !== remoteCount) {
      return `${tableName}: local ${localCount} rows, remote ${remoteCount} rows`;
    }
  }
  return null;
}

async function verifyTursoSourceConvergence(
  source: Awaited<ReturnType<typeof discoverTursoLinkedSources>>[number],
): Promise<TursoSourceVerifyResult> {
  const alias = source.alias;
  const syncKey = linkedSourceSyncKey(source);
  const base: TursoSourceVerifyResult = {
    alias,
    jobId: syncKey,
    ok: false,
  };

  if (!fs.existsSync(source.dbPath)) {
    return { ...base, ok: true, error: undefined };
  }

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return { ...base, error: "Turso sync not initialized" };
  }

  const pushState = loadTursoSyncState();
  const alternateKeys =
    source.jobId && source.jobId !== syncKey ? [source.jobId] : [];
  if (isJobDbDirty(syncKey, source.dbPath, pushState, alternateKeys)) {
    return { ...base, error: "Local database still dirty after push" };
  }

  const tursoDatabase = resolveTursoDatabaseLabel(source);
  let credentials;
  try {
    credentials = await bridge.fetchCredentials(tursoDatabase);
  } catch (err) {
    return {
      ...base,
      error: `Turso credentials unavailable: ${(err as Error).message.slice(0, 120)}`,
    };
  }

  const remote = createClient({
    url: credentials.tursoUrl,
    authToken: credentials.authToken,
  });
  const localDb = openWritableLocalJobDb(source.dbPath);

  try {
    const tableNames = filterSyncableTables(listUserTables(localDb));
    const localTableCount = tableNames.length;

    const remoteTablesResult = await remote.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    const remoteTableNames = filterSyncableTables(
      remoteTablesResult.rows.map((row) => String(row.name ?? "")),
    );
    const remoteTableCount = remoteTableNames.length;

    if (localTableCount > 0 && remoteTableCount < localTableCount) {
      return {
        ...base,
        localTableCount,
        remoteTableCount,
        error: `Remote missing tables (${remoteTableCount}/${localTableCount})`,
      };
    }

    const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
    if (migrationRoot && localTableCount > 0) {
      for (const migrationId of listLocalAppliedMigrationIds(localDb)) {
        if (!(await shouldVerifyMigrationOnRemote(migrationRoot, migrationId))) {
          continue;
        }
        const satisfied = await migrationSatisfiedOnRemote(
          remote,
          migrationRoot,
          migrationId,
        );
        if (!satisfied) {
          return {
            ...base,
            localTableCount,
            remoteTableCount,
            error: `Migration ${migrationId} not satisfied on Turso`,
          };
        }
      }
    }

    if (localTableCount > 0 && remoteTableCount > 0) {
      const rowMismatch = await verifySourceRowCounts(
        localDb,
        remote,
        tableNames,
      );
      if (rowMismatch) {
        return {
          ...base,
          localTableCount,
          remoteTableCount,
          error: `Row count mismatch: ${rowMismatch}`,
        };
      }
    }

    return {
      ...base,
      ok: true,
      localTableCount,
      remoteTableCount,
    };
  } catch (err) {
    return {
      ...base,
      error: (err as Error).message.slice(0, 160),
    };
  } finally {
    localDb.close();
    remote.close();
  }
}

/** Confirm origin/main matches local HEAD after a git push. */
export async function verifyGitRemoteSha(
  git: GitVerifyFn,
): Promise<GitVerifyResult> {
  return verifyGitRemoteShaOnce(git);
}

const GIT_VERIFY_RETRY_ATTEMPTS = 3;
const GIT_VERIFY_RETRY_DELAY_MS = 750;

async function verifyGitRemoteShaOnce(git: GitVerifyFn): Promise<GitVerifyResult> {
  try {
    await git(["fetch", "origin", "main"]);
    const localHead = (await git(["rev-parse", "HEAD"])).trim();
    const remoteHead = (await git(["rev-parse", "origin/main"])).trim();
    if (localHead !== remoteHead) {
      return {
        ok: false,
        localHead,
        remoteHead,
        error: `Local HEAD (${localHead.slice(0, 8)}) != origin/main (${remoteHead.slice(0, 8)})`,
      };
    }
    return { ok: true, localHead, remoteHead };
  } catch (err) {
    return {
      ok: false,
      localHead: "",
      remoteHead: "",
      error: (err as Error).message.slice(0, 160),
    };
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry transient HEAD != origin/main races after back-to-back namespace pushes. */
export async function verifyGitRemoteShaWithRetry(
  git: GitVerifyFn,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<GitVerifyResult> {
  const maxAttempts = options?.maxAttempts ?? GIT_VERIFY_RETRY_ATTEMPTS;
  const delayMs = options?.delayMs ?? GIT_VERIFY_RETRY_DELAY_MS;

  let lastResult: GitVerifyResult = {
    ok: false,
    localHead: "",
    remoteHead: "",
    error: "Git verify did not run",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await verifyGitRemoteShaOnce(git);
    if (lastResult.ok) {
      return lastResult;
    }
    const mismatch =
      lastResult.localHead.length > 0 &&
      lastResult.remoteHead.length > 0 &&
      lastResult.localHead !== lastResult.remoteHead;
    if (!mismatch || attempt >= maxAttempts) {
      return lastResult;
    }
    await sleepMs(delayMs * attempt);
  }

  return lastResult;
}

function gitAppSubtreePath(appId: string): string {
  return `apps/${appId}`;
}

async function readGitTreeSha(
  git: GitVerifyFn,
  revisionPath: string,
): Promise<string | null> {
  try {
    return (await git(["rev-parse", revisionPath])).trim();
  } catch {
    return null;
  }
}

/** Confirm this app's folder on origin/main matches local (not whole-repo HEAD). */
async function verifyGitAppSubtreeOnce(
  git: GitVerifyFn,
  appId: string,
): Promise<GitVerifyResult> {
  const appPath = gitAppSubtreePath(appId);
  try {
    await git(["fetch", "origin", "main"]);
    const localTreeSha = await readGitTreeSha(git, `HEAD:${appPath}`);
    if (!localTreeSha) {
      return {
        ok: false,
        localHead: "",
        remoteHead: "",
        appPath,
        error: `Local app path missing: ${appPath}`,
      };
    }

    const remoteTreeSha = await readGitTreeSha(git, `origin/main:${appPath}`);
    if (!remoteTreeSha) {
      return {
        ok: false,
        localHead: "",
        remoteHead: "",
        appPath,
        localTreeSha,
        error: `Remote app path missing: ${appPath}`,
      };
    }

    const localHead = (await git(["rev-parse", "HEAD"])).trim();
    const remoteHead = (await git(["rev-parse", "origin/main"])).trim();
    const workspaceHeadMismatch = localHead !== remoteHead;

    if (localTreeSha !== remoteTreeSha) {
      return {
        ok: false,
        localHead,
        remoteHead,
        appPath,
        localTreeSha,
        remoteTreeSha,
        workspaceHeadMismatch,
        error:
          `App ${appPath} tree local (${localTreeSha.slice(0, 8)}) != ` +
          `remote (${remoteTreeSha.slice(0, 8)})`,
      };
    }

    return {
      ok: true,
      localHead,
      remoteHead,
      appPath,
      localTreeSha,
      remoteTreeSha,
      workspaceHeadMismatch,
    };
  } catch (err) {
    return {
      ok: false,
      localHead: "",
      remoteHead: "",
      appPath,
      error: (err as Error).message.slice(0, 160),
    };
  }
}

/** Retry transient app-tree != remote races after back-to-back pushes. */
export async function verifyGitAppSubtreeWithRetry(
  git: GitVerifyFn,
  appId: string,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<GitVerifyResult> {
  const maxAttempts = options?.maxAttempts ?? GIT_VERIFY_RETRY_ATTEMPTS;
  const delayMs = options?.delayMs ?? GIT_VERIFY_RETRY_DELAY_MS;

  let lastResult: GitVerifyResult = {
    ok: false,
    localHead: "",
    remoteHead: "",
    appPath: gitAppSubtreePath(appId),
    error: "Git app verify did not run",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await verifyGitAppSubtreeOnce(git, appId);
    if (lastResult.ok) {
      return lastResult;
    }
    const treeMismatch =
      lastResult.localTreeSha &&
      lastResult.remoteTreeSha &&
      lastResult.localTreeSha !== lastResult.remoteTreeSha;
    if (!treeMismatch || attempt >= maxAttempts) {
      return lastResult;
    }
    await sleepMs(delayMs * attempt);
  }

  return lastResult;
}

/** Turso convergence for one app — migrations + table counts per linked alias. */
export async function verifyTursoConvergenceForApp(
  appId: string,
  appsRootDir?: string,
): Promise<TursoVerifyResult> {
  const appsRoot =
    appsRootDir ?? path.join(getPaprRoot(), "apps");
  const report = await buildTursoSyncItemsReport(appsRoot, appId);
  const appSources = report.sources.filter((source) => source.appId === appId);

  if (appSources.length === 0) {
    return { ok: true, sources: [], errors: [] };
  }

  const pending = appSources.filter(
    (source) => source.status !== "synced" && source.status !== "empty",
  );
  if (pending.length > 0) {
    const errors = pending.map(
      (source) =>
        `${source.alias}: status ${source.status}${source.schemaDrift ? " (schema drift)" : ""}`,
    );
    return { ok: false, sources: [], errors };
  }

  const linkedSources = (await discoverTursoLinkedSources(appsRoot)).filter(
    (source) => source.appId === appId,
  );

  const sources: TursoSourceVerifyResult[] = [];
  const errors: string[] = [];

  for (const source of linkedSources) {
    const result = await verifyTursoSourceConvergence(source);
    sources.push(result);
    if (!result.ok && result.error) {
      errors.push(`${result.alias}: ${result.error}`);
    }
  }

  return {
    ok: errors.length === 0,
    sources,
    errors,
  };
}

function resolveGitFn(
  paprDir: string,
  git?: GitVerifyFn,
): GitVerifyFn {
  if (git) {
    return git;
  }
  const runner = new GitRunner();
  return (args: string[]) => runner.run(args, { cwd: paprDir });
}

/** Full post-push verify for one app before marking synced / auto-publish. */
export async function verifyAppPushConvergence(
  appId: string,
  paprDir?: string,
  git?: GitVerifyFn,
  options?: { skipGit?: boolean },
): Promise<AppPushVerifyResult> {
  const root = paprDir ?? getPaprRoot();
  const appsRoot = path.join(root, "apps");
  const errors: string[] = [];
  const warnings: string[] = [];

  let gitResult: GitVerifyResult | null = null;
  if (!options?.skipGit && fs.existsSync(path.join(root, ".git"))) {
    gitResult = await verifyGitAppSubtreeWithRetry(
      resolveGitFn(root, git),
      appId,
    );
    if (!gitResult.ok && gitResult.error) {
      errors.push(`Git: ${gitResult.error}`);
    } else if (
      gitResult.ok &&
      gitResult.workspaceHeadMismatch &&
      gitResult.localHead &&
      gitResult.remoteHead
    ) {
      warnings.push(
        `Workspace git catching up (HEAD ${gitResult.localHead.slice(0, 8)} != origin/main ${gitResult.remoteHead.slice(0, 8)}); app code verified on remote`,
      );
    }
  }

  const tursoResult = await verifyTursoConvergenceForApp(appId, appsRoot);
  if (!tursoResult.ok) {
    errors.push(...tursoResult.errors.map((entry) => `Turso: ${entry}`));
  }

  return {
    ok: errors.length === 0,
    git: gitResult,
    turso: tursoResult,
    errors,
    warnings,
  };
}

export async function assertAppPushVerified(
  appId: string,
  paprDir?: string,
  git?: GitVerifyFn,
): Promise<AppPushVerifyResult> {
  const result = await verifyAppPushConvergence(appId, paprDir, git);
  if (!result.ok) {
    throw new Error(
      `Post-push verify failed for ${appId}: ${result.errors.join("; ")}`,
    );
  }
  return result;
}
