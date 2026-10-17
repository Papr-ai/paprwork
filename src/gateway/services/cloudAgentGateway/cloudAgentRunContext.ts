/**
 * Shared setup + teardown for cloud agent gateway runs.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Provider } from "../../../core/types/agents.js";
import { isWarmWorkspaceFresh } from "./appRepoCloneCache.js";
import {
  cloneUserRepoToPaprHome,
  materializeAppWorkspaceToPaprHome,
} from "./cloneUserRepo.js";
import { rewritePaprPathForCloudRun } from "./cloudPaprPath.js";
import { prepareCloudJobEnvironment } from "./prepareCloudJobEnvironment.js";
import { seedCloudDatabaseRegistry } from "./seedCloudDatabaseRegistry.js";
import { reinitializeWorkspaceServicesForCloudRun } from "./reinitializeWorkspaceServices.js";
import { startCloudAgentTursoDebouncedPush } from "./cloudAgentTursoDebouncedPush.js";
import {
  disableCloudAppWriterForRun,
  getCloudAppWriterPushedAppIds,
  startCloudAppWriterDebouncedPush,
} from "./cloudAppWriterDebouncedPush.js";
import {
  isSkippedEmptyTursoTarget,
  notifyCloudDbChangedForTarget,
  tursoTargetHasLocalData,
  type TursoPushOutcome,
} from "./cloudTursoPushHelpers.js";
import { notifyCloudDbChanged } from "../cloudSync/notifyCloudDbChanged.js";
import {
  pullLinkedSourceFromCloud,
  pushLinkedSourceToCloud,
  type TursoBookendTarget,
} from "./syncJobTursoBookends.js";
import { reconcileCloudProviderAuth } from "./resolveCloudProviderAuth.js";
import { clearKeyCache, seedPaprApiKeyFromParent } from "../../utils/keyResolver.js";
import { invalidatePaprUserIdCache } from "../../utils/paprUserId.js";
import { hydrateSubAgentsRegistryForCloudRun, applySubAgentsHydrationFromMongo } from "./hydrateSubAgentsRegistryForCloudRun.js";
import { fetchSubAgentsIndexFromCloudDirect } from "../syncV3/MetadataRegistryClient.js";
import type { CloudAgentRunRequest, CloudLinkedSource, CloudTursoSource } from "./types.js";
import { shouldUseCloudSandboxTursoDirect } from "./cloudSandboxTursoDirect.js";
import {
  resolveCloudAgentChatId,
  resolveCloudAppAgentStreamOverrides,
  resolveCloudUserDataPath,
} from "./cloudAppAgentSession.js";
import { resolveCloudWorkspaceChatStreamOverrides } from "./cloudWorkspaceChatSession.js";
import { getJobsService } from "../JobsService.js";
import {
  AgentJobExecutor,
  type AgentJobSessionInput,
} from "../jobs/executors/AgentJobExecutor.js";
import type { JobType } from "../jobs/types.js";
import { isJobScratchDatabasePath } from "../jobs/jobScratchDatabasePath.js";
import { normalizeRuntimeParams } from "../../utils/normalizeRuntimeParams.js";

export interface CloudRunHandle {
  runRoot: string;
  paprHome: string;
  tursoTargets: TursoBookendTarget[];
  finish: (options?: { deleteWorkspace?: boolean; prepOnly?: boolean }) => Promise<void>;
}

interface CloudRunEnvSnapshot {
  previousPaprHome?: string;
  previousPaprUserData?: string;
  previousPaprOrgId?: string;
  previousPaprNamespaceId?: string;
  previousPaprApiKey?: string;
  previousHome?: string;
  previousJobDir?: string;
  previousJobDb?: string;
  previousAppId?: string;
  previousAppDb?: string;
  previousAppDbAlias?: string;
  previousVaultEnv: Map<string, string | undefined>;
  previousTelemetryPaprUserId?: string;
}

export function resolveCloudRunRoot(request: CloudAgentRunRequest): string {
  const key = request.workspaceSessionId ?? request.runId;
  const baseDir = request.workspaceSessionId ? "papr-cloud-session" : "papr-cloud-run";
  return path.join(os.tmpdir(), baseDir, key);
}

function dbEventIdsForSyncKey(
  syncKey: string,
  linked?: CloudLinkedSource,
): Pick<TursoBookendTarget, "jobId" | "dbId"> {
  if (linked?.dbId) {
    return {
      dbId: linked.dbId,
      ...(linked.jobId ? { jobId: linked.jobId } : {}),
    };
  }
  if (linked?.jobId) {
    return { jobId: linked.jobId };
  }
  if (syncKey.startsWith("db-")) {
    return { dbId: syncKey };
  }
  return { jobId: syncKey };
}

export function resolveTursoBookendTargets(
  request: CloudAgentRunRequest,
  paprHome: string,
): TursoBookendTarget[] {
  const byKey = new Map<string, TursoBookendTarget>();
  const linkedByKey = new Map<string, CloudLinkedSource>();
  for (const linked of request.linkedSources ?? []) {
    if (linked.dbId) {
      linkedByKey.set(linked.dbId, linked);
    }
    if (linked.jobId) {
      linkedByKey.set(linked.jobId, linked);
    }
  }

  const addSource = (source: CloudTursoSource): void => {
    const dbPath = rewritePaprPathForCloudRun(source.dbPath, paprHome);
    const syncKey = source.syncKey;
    // Job scratch (Jobs/{id}/data/data.db) is local-only — never Turso.
    if (!syncKey || byKey.has(syncKey) || isJobScratchDatabasePath(dbPath)) {
      return;
    }
    const linked = linkedByKey.get(syncKey);
    byKey.set(syncKey, {
      syncKey,
      dbPath,
      tursoUrl: source.databaseUrl,
      authToken: source.authToken,
      ...dbEventIdsForSyncKey(syncKey, linked),
      jobId: request.jobId,
    });
  };

  if (request.tursoSources?.length) {
    for (const source of request.tursoSources) {
      addSource(source);
    }
  }
  // Legacy request.turso always targeted Jobs/{id}/data/data.db (job scratch),
  // which is no longer synced to Turso — ignore it.

  return [...byKey.values()];
}

function captureCloudRunEnv(): CloudRunEnvSnapshot {
  return {
    previousPaprHome: process.env.PAPR_HOME,
    previousPaprUserData: process.env.PAPR_USER_DATA,
    previousPaprOrgId: process.env.PAPR_ORG_ID,
    previousPaprNamespaceId: process.env.PAPR_NAMESPACE_ID,
    previousPaprApiKey: process.env.PAPR_API_KEY,
    previousHome: process.env.HOME,
    previousJobDir: process.env.JOB_DIR,
    previousJobDb: process.env.JOB_DB,
    previousAppId: process.env.APP_ID,
    previousAppDb: process.env.APP_DB,
    previousAppDbAlias: process.env.APP_DB_ALIAS,
    previousVaultEnv: new Map(),
    previousTelemetryPaprUserId: process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID,
  };
}

function applyVaultKeys(
  request: CloudAgentRunRequest,
  snapshot: CloudRunEnvSnapshot,
): void {
  if (!request.vaultKeys) {
    return;
  }
  for (const [keyName, value] of Object.entries(request.vaultKeys)) {
    if (!value) continue;
    snapshot.previousVaultEnv.set(keyName, process.env[keyName]);
    process.env[keyName] = value;
  }
}

function applyPaprApiKey(
  request: CloudAgentRunRequest,
  snapshot: CloudRunEnvSnapshot,
): void {
  const key = request.paprApiKey?.trim();
  if (!key) {
    return;
  }
  snapshot.previousPaprApiKey = process.env.PAPR_API_KEY;
  process.env.PAPR_API_KEY = key;
  clearKeyCache("PAPR_API_KEY");
  // Memory already authenticated this key for request.namespaceId, so it is
  // namespace-bound like a vault slot — not an untrusted .env value. Without
  // this, legacy-format keys (no embedded namespace) are rejected by the
  // resolver and the run silently loses chat sync / Papr memory.
  if (!seedPaprApiKeyFromParent(key)) {
    console.warn("[CloudAgentRun] request PAPR_API_KEY not bound to the run workspace — not seeded");
  }
}

async function restoreCloudRunEnv(snapshot: CloudRunEnvSnapshot): Promise<void> {
  if (snapshot.previousPaprHome === undefined) delete process.env.PAPR_HOME;
  else process.env.PAPR_HOME = snapshot.previousPaprHome;
  if (snapshot.previousPaprUserData === undefined) delete process.env.PAPR_USER_DATA;
  else process.env.PAPR_USER_DATA = snapshot.previousPaprUserData;
  if (snapshot.previousPaprOrgId === undefined) delete process.env.PAPR_ORG_ID;
  else process.env.PAPR_ORG_ID = snapshot.previousPaprOrgId;
  if (snapshot.previousPaprNamespaceId === undefined) delete process.env.PAPR_NAMESPACE_ID;
  else process.env.PAPR_NAMESPACE_ID = snapshot.previousPaprNamespaceId;
  if (snapshot.previousPaprApiKey === undefined) delete process.env.PAPR_API_KEY;
  else process.env.PAPR_API_KEY = snapshot.previousPaprApiKey;
  clearKeyCache("PAPR_API_KEY");
  if (snapshot.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = snapshot.previousHome;
  if (snapshot.previousJobDir === undefined) delete process.env.JOB_DIR;
  else process.env.JOB_DIR = snapshot.previousJobDir;
  if (snapshot.previousJobDb === undefined) delete process.env.JOB_DB;
  else process.env.JOB_DB = snapshot.previousJobDb;
  if (snapshot.previousAppId === undefined) delete process.env.APP_ID;
  else process.env.APP_ID = snapshot.previousAppId;
  if (snapshot.previousAppDb === undefined) delete process.env.APP_DB;
  else process.env.APP_DB = snapshot.previousAppDb;
  if (snapshot.previousAppDbAlias === undefined) delete process.env.APP_DB_ALIAS;
  else process.env.APP_DB_ALIAS = snapshot.previousAppDbAlias;

  if (snapshot.previousTelemetryPaprUserId === undefined) {
    delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
  } else {
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = snapshot.previousTelemetryPaprUserId;
  }
  invalidatePaprUserIdCache();

  for (const [keyName, previousValue] of snapshot.previousVaultEnv.entries()) {
    if (previousValue === undefined) delete process.env[keyName];
    else process.env[keyName] = previousValue;
  }
}

function applyWorkspaceProcessEnv(
  request: CloudAgentRunRequest,
  paprHome: string,
  userDataPath: string,
  runRoot: string,
  envSnapshot: CloudRunEnvSnapshot,
): void {
  process.env.PAPR_HOME = paprHome;
  process.env.PAPR_USER_DATA = userDataPath;
  if (request.orgId) {
    process.env.PAPR_ORG_ID = request.orgId;
  }
  if (request.namespaceId) {
    process.env.PAPR_NAMESPACE_ID = request.namespaceId;
  }
  const actingUserId = request.userId?.trim();
  if (actingUserId) {
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = actingUserId;
    invalidatePaprUserIdCache();
  }
  process.env.HOME = runRoot;
  // App-scope runs serve the app's visitors: no personal memory injection.
  envSnapshot.previousVaultEnv.set(
    "PAPR_SKIP_USER_MEMORY_CONTEXT",
    process.env.PAPR_SKIP_USER_MEMORY_CONTEXT,
  );
  if (request.workspaceScope === "app") process.env.PAPR_SKIP_USER_MEMORY_CONTEXT = "1";
  else delete process.env.PAPR_SKIP_USER_MEMORY_CONTEXT;
  applyVaultKeys(request, envSnapshot);
  applyPaprApiKey(request, envSnapshot);
}

async function ensureTursoLocalFiles(tursoTargets: TursoBookendTarget[]): Promise<void> {
  for (const target of tursoTargets) {
    try {
      await fs.access(target.dbPath);
    } catch {
      await fs.mkdir(path.dirname(target.dbPath), { recursive: true });
      await fs.writeFile(target.dbPath, "");
    }
  }
}

async function pullTursoTargets(tursoTargets: TursoBookendTarget[]): Promise<void> {
  await ensureTursoLocalFiles(tursoTargets);
  for (const target of tursoTargets) {
    await pullLinkedSourceFromCloud(target);
  }
}

async function pushTursoTargets(
  tursoTargets: TursoBookendTarget[],
): Promise<TursoPushOutcome> {
  if (tursoTargets.length === 0) {
    return { ok: true, failures: [], retainSandbox: false };
  }

  const failures: string[] = [];
  let retainSandbox = false;

  for (const target of tursoTargets) {
    const hadLocalData = tursoTargetHasLocalData(target.dbPath);
    const result = await pushLinkedSourceToCloud(target);
    if (isSkippedEmptyTursoTarget(result)) {
      if (
        result.reason === "local_db_empty" ||
        result.reason === "local_db_missing"
      ) {
        console.log(
          `[CloudAgentRun] Skipping empty Turso target ${target.syncKey} (${result.reason})`,
        );
      }
      continue;
    }
    if (result.status !== "pushed") {
      failures.push(
        `${target.syncKey}@${target.dbPath}: ${result.reason ?? result.error ?? "unknown"} (status=${result.status})`,
      );
      if (hadLocalData) {
        retainSandbox = true;
      }
      continue;
    }
    await notifyCloudDbChangedForTarget(target, result);
  }

  return {
    ok: failures.length === 0,
    failures,
    retainSandbox,
  };
}

export interface BeginCloudAgentRunOptions {
  /** Skip git clone when workspace directory already exists (session reuse). */
  skipClone?: boolean;
  runRoot?: string;
  /** Warm-only: clone + hydrate on disk; skip job env, Turso bookends, and sync push on finish. */
  prepOnly?: boolean;
  /**
   * Turn in a warm session whose workspace was verified fresh moments ago:
   * skip the git ls-remote HEAD check and the sub-agent re-hydrate (both were
   * done at warm; publishes invalidate the session separately).
   */
  trustWarmWorkspace?: boolean;
  /**
   * prepOnly: also bind workspace services to this workspace now, so the first
   * turn finds them ready instead of paying the re-init after the user hits send.
   */
  prebindServices?: boolean;
}

/**
 * Workspace singletons (jobs, apps, agent, registry) are path-bound. The
 * gateway runs one request at a time (Cloud Run concurrency=1), so when the
 * next turn is for the same warm workspace and identity they are still bound
 * to it — re-initialising them again was the bulk of every turn's setup.
 */
let boundWorkspaceKey: string | null = null;

export function resetBoundCloudWorkspaceForTests(): void {
  boundWorkspaceKey = null;
}

/** Workspace on disk was removed or replaced — services must rebind next run. */
export function forgetBoundCloudWorkspace(runRoot?: string): void {
  if (!runRoot || (boundWorkspaceKey && boundWorkspaceKey.startsWith(runRoot))) {
    boundWorkspaceKey = null;
  }
}

export function isCloudWorkspaceBoundForTests(
  request: CloudAgentRunRequest,
  paprHome: string,
): boolean {
  return boundWorkspaceKey === workspaceBindingKey(request, paprHome);
}

function workspaceBindingKey(request: CloudAgentRunRequest, paprHome: string): string {
  return [paprHome, request.userId ?? "", request.orgId ?? "", request.namespaceId ?? "",
    request.paprApiKey?.slice(-12) ?? ""].join("|");
}

async function timed<T>(label: string, timings: string[], fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings.push(`${label}=${Date.now() - started}ms`);
  }
}

export async function beginCloudAgentRun(
  request: CloudAgentRunRequest,
  options: BeginCloudAgentRunOptions = {},
): Promise<CloudRunHandle> {
  const runRoot = options.runRoot ?? resolveCloudRunRoot(request);
  const paprHome =
    request.namespaceId && request.orgId
      ? path.join(
          runRoot,
          "Papr",
          "orgs",
          request.orgId,
          "namespaces",
          request.namespaceId,
        )
      : path.join(runRoot, "Papr");
  const envSnapshot = captureCloudRunEnv();
  const tursoTargets = resolveTursoBookendTargets(request, paprHome);
  const runStarted = Date.now();
  const timings: string[] = [];

  const prepOnly = options.prepOnly === true;
  let skipClone = options.skipClone === true;

  if (skipClone) {
    try {
      await fs.access(paprHome);
    } catch {
      throw new Error(
        `Warm workspace missing on disk for session ${request.workspaceSessionId ?? request.runId}`,
      );
    }

    if (
      options.trustWarmWorkspace !== true &&
      request.workspaceScope === "app" &&
      request.appRepoOwner &&
      request.appRepoName
    ) {
      const warmFresh = await isWarmWorkspaceFresh({
        paprHome,
        owner: request.appRepoOwner,
        repo: request.appRepoName,
        branch: request.repoBranch,
        token: request.repoToken,
      });
      if (!warmFresh) {
        console.log(
          `[CloudAgentRun] Warm workspace stale for ${request.appRepoOwner}/${request.appRepoName} ` +
            `session=${request.workspaceSessionId ?? request.runId} — rematerializing`,
        );
        skipClone = false;
      }
    }
  }

  const mongoHydratePromise = skipClone
    ? null
    : fetchSubAgentsIndexFromCloudDirect(request.paprApiKey).catch(() => null);

  if (!skipClone) {
    forgetBoundCloudWorkspace(runRoot);
    if (
      request.workspaceScope === "app" &&
      request.appId &&
      request.appRepoOwner &&
      request.appRepoName
    ) {
      await materializeAppWorkspaceToPaprHome({
        targetPaprHome: paprHome,
        appId: request.appId,
        jobId: request.jobId,
        owner: request.appRepoOwner,
        repo: request.appRepoName,
        token: request.repoToken,
        branch: request.repoBranch,
        scaffoldFiles: request.scaffoldFiles,
      });
    } else {
      if (!request.repoCloneUrl) {
        throw new Error(
          "repoCloneUrl is required for namespace workspace clone",
        );
      }
      await cloneUserRepoToPaprHome({
        targetPaprHome: paprHome,
        cloneUrl: request.repoCloneUrl,
        token: request.repoToken,
        branch: request.repoBranch,
      });
    }
  }

  const userDataPath = resolveCloudUserDataPath(runRoot);
  await fs.mkdir(userDataPath, { recursive: true });

  try {
    if (mongoHydratePromise) {
      const mongoEntries = await mongoHydratePromise;
      if (mongoEntries !== null) {
        await applySubAgentsHydrationFromMongo(paprHome, mongoEntries);
      }
    } else if (options.trustWarmWorkspace !== true) {
      await hydrateSubAgentsRegistryForCloudRun({
        paprHome,
        paprApiKey: request.paprApiKey,
      });
    }
  } catch (err) {
    console.warn(
      "[CloudAgentRun] Sub-agents Mongo hydrate failed:",
      (err as Error).message.slice(0, 160),
    );
  }

  if (prepOnly && options.prebindServices) {
    try {
      await timed("prebindServices", timings, async () => {
        applyWorkspaceProcessEnv(request, paprHome, userDataPath, runRoot, envSnapshot);
        const tursoDirect = shouldUseCloudSandboxTursoDirect(paprHome);
        await seedCloudDatabaseRegistry(request, paprHome, { cloudDirect: tursoDirect });
        boundWorkspaceKey = null;
        await reinitializeWorkspaceServicesForCloudRun({
          paprApiKey: request.paprApiKey,
          userDataPath,
        });
        boundWorkspaceKey = workspaceBindingKey(request, paprHome);
      });
    } catch (err) {
      boundWorkspaceKey = null;
      console.warn(
        "[CloudAgentRun] Warm prebind failed (first turn will bind):",
        (err as Error).message.slice(0, 160),
      );
    } finally {
      await restoreCloudRunEnv(envSnapshot);
    }
    console.log(
      `[CloudAgentRun] warm setup ${Date.now() - runStarted}ms (skipClone=${skipClone}) ${timings.join(" ")}`,
    );
  }

  if (prepOnly) {
    return {
      runRoot,
      paprHome,
      tursoTargets,
      finish: async (finishOptions?: { deleteWorkspace?: boolean; prepOnly?: boolean }) => {
        if (finishOptions?.deleteWorkspace) {
          forgetBoundCloudWorkspace(runRoot);
          forgetBoundCloudWorkspace(runRoot);
        await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }

  applyWorkspaceProcessEnv(request, paprHome, userDataPath, runRoot, envSnapshot);

  // Before services re-init: the registry singleton loads data/databases.json there.
  const tursoDirect = shouldUseCloudSandboxTursoDirect(paprHome);
  const seeded = await timed("seedRegistry", timings, () =>
    seedCloudDatabaseRegistry(request, paprHome, { cloudDirect: tursoDirect }),
  );
  const bindingKey = workspaceBindingKey(request, paprHome);
  // Replica mode seeds new registry entries on disk that the registry
  // singleton only reads at init — rebind in that case.
  const canReuseServices =
    boundWorkspaceKey === bindingKey && (tursoDirect || seeded.length === 0);
  if (canReuseServices) {
    timings.push("reinitServices=reused");
  } else {
    boundWorkspaceKey = null;
    await timed("reinitServices", timings, () =>
      reinitializeWorkspaceServicesForCloudRun({
        paprApiKey: request.paprApiKey,
        userDataPath,
      }),
    );
    boundWorkspaceKey = bindingKey;
  }

  await timed("jobEnv", timings, () =>
    prepareCloudJobEnvironment({
      jobId: request.jobId,
      userId: request.userId,
      tursoSources: request.tursoSources,
    }),
  );

  let tursoDebouncedPush: Awaited<
    ReturnType<typeof startCloudAgentTursoDebouncedPush>
  > | null = null;
  if (tursoDirect) {
    console.log(
      "[CloudAgentRun] Turso direct mode — skipping pull/push bookends and debounced SQLite watcher",
    );
  } else {
    await timed("tursoPull", timings, () => pullTursoTargets(tursoTargets));
    tursoDebouncedPush = await startCloudAgentTursoDebouncedPush(tursoTargets);
  }
  // Only Maintainers / Admins change the live app. Anyone else's edits stay in
  // this sandbox (the writer would refuse them anyway — skipping avoids a
  // failed run and a wasted round trip).
  const canPushAppCode = request.appCodePush === "main"; // fail closed
  const writerDebouncedPush = canPushAppCode
    ? await startCloudAppWriterDebouncedPush(
        request.workspaceScope === "app" && request.appId ? { onlyAppId: request.appId } : {},
      )
    : (disableCloudAppWriterForRun(request.callerRole), null);
  console.log(
    `[CloudAgentRun] setup ${Date.now() - runStarted}ms ` +
      `(skipClone=${skipClone} trusted=${options.trustWarmWorkspace === true}) ${timings.join(" ")}`,
  );

  return {
    runRoot,
    paprHome,
    tursoTargets,
    finish: async (finishOptions?: { deleteWorkspace?: boolean; prepOnly?: boolean }) => {
      if (finishOptions?.prepOnly) {
        await restoreCloudRunEnv(envSnapshot);
        if (finishOptions.deleteWorkspace) {
          forgetBoundCloudWorkspace(runRoot);
          forgetBoundCloudWorkspace(runRoot);
        await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return;
      }
      let syncSucceeded = true;
      let retainSandbox = false;
      let writerPushedAppIds: string[] = [];
      try {
        if (tursoDebouncedPush) {
          await tursoDebouncedPush.flush();
          await tursoDebouncedPush.stop();
        }
        if (writerDebouncedPush) {
          const writerResult = await writerDebouncedPush.flushAndStop();
          writerPushedAppIds = getCloudAppWriterPushedAppIds();
          if (writerResult.failed.length > 0) {
            syncSucceeded = false;
            retainSandbox = true;
            throw new Error(
              `App code writer flush failed: ${writerResult.failed
                .map((failure) => `${failure.appId} (${failure.error})`)
                .join("; ")}`,
            );
          }
        }
        if (!tursoDirect) {
          const outcome = await pushTursoTargets(tursoTargets);
          if (!outcome.ok) {
            syncSucceeded = false;
            retainSandbox = outcome.retainSandbox;
            throw new Error(
              `Turso sync did not complete for cloud agent run. ${outcome.failures.join("; ")}`,
            );
          }
        } else if (tursoTargets.length > 0) {
          // Direct Turso writes skip push bookends — still notify cloud app host for SSE.
          for (const target of tursoTargets) {
            await notifyCloudDbChanged({
              ...(target.jobId ? { jobId: target.jobId } : {}),
              ...(target.dbId ? { dbId: target.dbId } : {}),
              tables: [],
            });
          }
        }

        if (writerPushedAppIds.length > 0) {
          const { syncPublishedAppCatalogLayer } = await import(
            "../syncV3/syncPublishedAppCatalogLayer.js"
          );
          const { webReady } = await import("../cloudSync/webReady.js");
          for (const appId of writerPushedAppIds) {
            const ready = await webReady(appId, paprHome);
            if (!ready.ready) {
              console.warn(
                `[CloudAgentRun] Skipping catalog sync for ${appId}: ${ready.detail ?? ready.reason ?? "not web-ready"}`,
              );
              continue;
            }
            await syncPublishedAppCatalogLayer(appId, { afterWriterChange: true });
          }
        }
      } catch (error) {
        syncSucceeded = false;
        if (!retainSandbox) {
          retainSandbox = !tursoDirect && tursoTargets.some((target) =>
            tursoTargetHasLocalData(target.dbPath),
          );
        }
        console.error(
          `[CloudAgentRun] Turso push failed for ${runRoot}:`,
          (error as Error).message,
        );
        throw error;
      } finally {
        await restoreCloudRunEnv(envSnapshot);

        const deleteWorkspace = finishOptions?.deleteWorkspace ?? true;
        if (!deleteWorkspace) {
          return;
        }
        if (syncSucceeded) {
          forgetBoundCloudWorkspace(runRoot);
          forgetBoundCloudWorkspace(runRoot);
        await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
          return;
        }
        if (retainSandbox) {
          console.warn(
            `[CloudAgentRun] Retaining sandbox at ${runRoot} — local DB data did not sync to Turso`,
          );
          return;
        }
        console.log(
          `[CloudAgentRun] No local DB data to recover — deleting sandbox at ${runRoot}`,
        );
        forgetBoundCloudWorkspace(runRoot);
        await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export async function withCloudAgentRunContext<T>(
  request: CloudAgentRunRequest,
  run: () => Promise<T>,
): Promise<T> {
  const handle = await beginCloudAgentRun(request);
  try {
    return await run();
  } finally {
    await handle.finish();
  }
}

const UNUSED_DEFAULT_COMMANDS: Record<
  Exclude<JobType, "agent" | "subagent">,
  string
> = {
  shell: "",
  bash: "",
  node: "",
  python: "",
  swift: "",
};

function applyRuntimeParamsToProcessEnv(
  runtimeParams: Record<string, string> | undefined,
): void {
  if (!runtimeParams) return;
  for (const [key, value] of Object.entries(normalizeRuntimeParams(runtimeParams))) {
    if (key === "prompt") continue;
    process.env[key] = value;
  }
}

/**
 * Resolve cloud agent stream input using the same AgentJobExecutor assembly as desktop.
 * Must run after beginCloudAgentRun (cloned PAPR_HOME + prepareCloudJobEnvironment).
 */
export async function resolveCloudAgentJobStreamInput(
  request: CloudAgentRunRequest,
): Promise<{
  jobId: string;
  runId: string;
  prompt: string;
  chatId: string;
  streamUserMessage: string;
  systemPromptOverride?: string;
  provider: Provider;
  model?: string;
  allowedToolIds?: string[];
  maxTurns?: number;
  authOverride: { apiKey: string; authType: "oauth" | "apiKey" };
  paprApiKey?: string;
  session: AgentJobSessionInput;
  appendLog: (line: string) => Promise<void>;
}> {
  applyRuntimeParamsToProcessEnv(request.runtimeParams);

  const jobsService = getJobsService();
  await jobsService.initialize();
  const job = await jobsService.getJob(request.jobId);
  if (!job) {
    throw new Error(`Job not found in cloned workspace: ${request.jobId}`);
  }
  if (job.type !== "agent" && job.type !== "subagent") {
    throw new Error(`Job ${request.jobId} is not an agent job (type=${job.type})`);
  }

  const jobDir = await jobsService.getJobPath(request.jobId);
  if (!jobDir) {
    throw new Error(`Job directory not found for ${request.jobId}`);
  }

  const executor = new AgentJobExecutor();
  const appendLog = async (line: string): Promise<void> => {
    console.log(`[CloudJobLog][${request.jobId}] ${line}`);
    await jobsService.appendJobRunLog(request.jobId, line);
  };
  const session = await executor.buildSessionInput({
    runId: request.runId,
    job,
    jobDir,
    defaultCommandByType: UNUSED_DEFAULT_COMMANDS,
    appendLog,
    runtimeParams: request.runtimeParams,
  });

  const llmAuth = reconcileCloudProviderAuth({
    provider: request.llmAuth.provider as Provider,
    token: request.llmAuth.token,
    authType: request.llmAuth.authType,
  });

  const provider = session.provider ?? llmAuth.provider;
  const model = session.model ?? request.model;

  const workspaceChatOverrides = await resolveCloudWorkspaceChatStreamOverrides(request);
  const appAgentOverrides =
    workspaceChatOverrides == null
      ? await resolveCloudAppAgentStreamOverrides(request)
      : null;
  const streamOverrides = workspaceChatOverrides ?? appAgentOverrides;
  const chatId = streamOverrides?.chatId ?? resolveCloudAgentChatId(request);

  if (workspaceChatOverrides) {
    const { seedWorkspaceChatHistoryFromClient } = await import(
      "./workspaceClientHistorySeed.js"
    );
    await seedWorkspaceChatHistoryFromClient(
      chatId,
      request.runtimeParams?.clientHistory,
    );
  }

  return {
    jobId: session.jobId,
    runId: session.runId,
    prompt: session.prompt,
    chatId,
    streamUserMessage: streamOverrides?.userMessage ?? session.prompt,
    ...(streamOverrides?.systemPrompt
      ? { systemPromptOverride: streamOverrides.systemPrompt }
      : {}),
    provider,
    model,
    allowedToolIds:
      appAgentOverrides?.allowedToolIds ??
      session.allowedToolIds ??
      request.allowedToolIds,
    maxTurns: session.maxTurns ?? request.maxTurns,
    authOverride: {
      apiKey: llmAuth.token,
      authType: llmAuth.authType,
    },
    paprApiKey: request.paprApiKey,
    session,
    appendLog,
  };
}

/** @deprecated Use resolveCloudAgentJobStreamInput for agent jobs. */
export function cloudAgentStreamInput(request: CloudAgentRunRequest): {
  jobId: string;
  runId: string;
  prompt: string;
  provider: Provider;
  model?: string;
  allowedToolIds?: string[];
  maxTurns?: number;
  authOverride: { apiKey: string; authType: "oauth" | "apiKey" };
  paprApiKey?: string;
} {
  const llmAuth = reconcileCloudProviderAuth({
    provider: request.llmAuth.provider as Provider,
    token: request.llmAuth.token,
    authType: request.llmAuth.authType,
  });

  return {
    jobId: request.jobId,
    runId: request.runId,
    prompt: request.prompt ?? "",
    provider: llmAuth.provider,
    model: request.model,
    allowedToolIds: request.allowedToolIds,
    maxTurns: request.maxTurns,
    authOverride: {
      apiKey: llmAuth.token,
      authType: llmAuth.authType,
    },
    paprApiKey: request.paprApiKey,
  };
}
