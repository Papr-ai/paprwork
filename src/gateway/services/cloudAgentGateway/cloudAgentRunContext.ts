/**
 * Shared setup + teardown for cloud agent gateway runs.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Provider } from "../../../core/types/agents.js";
import { cloneUserRepoToPaprHome } from "./cloneUserRepo.js";
import { rewritePaprPathForCloudRun } from "./cloudPaprPath.js";
import { prepareCloudJobEnvironment } from "./prepareCloudJobEnvironment.js";
import { reinitializeWorkspaceServicesForCloudRun } from "./reinitializeWorkspaceServices.js";
import { startCloudAgentTursoDebouncedPush } from "./cloudAgentTursoDebouncedPush.js";
import { startCloudAppWriterDebouncedPush, getCloudAppWriterPushedAppIds } from "./cloudAppWriterDebouncedPush.js";
import {
  isSkippedEmptyTursoTarget,
  notifyCloudDbChangedForTarget,
  tursoTargetHasLocalData,
  type TursoPushOutcome,
} from "./cloudTursoPushHelpers.js";
import {
  pullLinkedSourceFromCloud,
  pushLinkedSourceToCloud,
  type TursoBookendTarget,
} from "./syncJobTursoBookends.js";
import { reconcileCloudProviderAuth } from "./resolveCloudProviderAuth.js";
import type { CloudAgentRunRequest, CloudLinkedSource, CloudTursoSource } from "./types.js";
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
import { normalizeRuntimeParams } from "../../utils/normalizeRuntimeParams.js";

export interface CloudRunHandle {
  runRoot: string;
  paprHome: string;
  tursoTargets: TursoBookendTarget[];
  finish: (options?: { deleteWorkspace?: boolean }) => Promise<void>;
}

interface CloudRunEnvSnapshot {
  previousPaprHome?: string;
  previousPaprUserData?: string;
  previousHome?: string;
  previousJobDir?: string;
  previousJobDb?: string;
  previousAppId?: string;
  previousAppDb?: string;
  previousAppDbAlias?: string;
  previousVaultEnv: Map<string, string | undefined>;
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
    if (!syncKey || byKey.has(syncKey)) {
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
  } else if (request.turso) {
    const jobDbPath = path.join(paprHome, "Jobs", request.turso.jobId, "data", "data.db");
    const linked = linkedByKey.get(request.turso.jobId);
    byKey.set(request.turso.jobId, {
      syncKey: request.turso.jobId,
      dbPath: jobDbPath,
      tursoUrl: request.turso.databaseUrl,
      authToken: request.turso.authToken,
      ...dbEventIdsForSyncKey(request.turso.jobId, linked),
      jobId: request.jobId,
    });
  }

  return [...byKey.values()];
}

function captureCloudRunEnv(): CloudRunEnvSnapshot {
  return {
    previousPaprHome: process.env.PAPR_HOME,
    previousPaprUserData: process.env.PAPR_USER_DATA,
    previousHome: process.env.HOME,
    previousJobDir: process.env.JOB_DIR,
    previousJobDb: process.env.JOB_DB,
    previousAppId: process.env.APP_ID,
    previousAppDb: process.env.APP_DB,
    previousAppDbAlias: process.env.APP_DB_ALIAS,
    previousVaultEnv: new Map(),
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

async function restoreCloudRunEnv(snapshot: CloudRunEnvSnapshot): Promise<void> {
  if (snapshot.previousPaprHome === undefined) delete process.env.PAPR_HOME;
  else process.env.PAPR_HOME = snapshot.previousPaprHome;
  if (snapshot.previousPaprUserData === undefined) delete process.env.PAPR_USER_DATA;
  else process.env.PAPR_USER_DATA = snapshot.previousPaprUserData;
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

  for (const [keyName, previousValue] of snapshot.previousVaultEnv.entries()) {
    if (previousValue === undefined) delete process.env[keyName];
    else process.env[keyName] = previousValue;
  }
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

  const skipClone = options.skipClone === true;
  if (!skipClone) {
    await cloneUserRepoToPaprHome({
      targetPaprHome: paprHome,
      cloneUrl: request.repoCloneUrl,
      token: request.repoToken,
      branch: request.repoBranch,
    });
  } else {
    try {
      await fs.access(paprHome);
    } catch {
      throw new Error(
        `Warm workspace missing on disk for session ${request.workspaceSessionId ?? request.runId}`,
      );
    }
  }

  const userDataPath = resolveCloudUserDataPath(runRoot);
  await fs.mkdir(userDataPath, { recursive: true });

  process.env.PAPR_HOME = paprHome;
  process.env.PAPR_USER_DATA = userDataPath;
  if (request.orgId) {
    process.env.PAPR_ORG_ID = request.orgId;
  }
  if (request.namespaceId) {
    process.env.PAPR_NAMESPACE_ID = request.namespaceId;
  }
  process.env.HOME = runRoot;
  applyVaultKeys(request, envSnapshot);

  await reinitializeWorkspaceServicesForCloudRun({
    paprApiKey: request.paprApiKey,
    userDataPath,
  });
  await prepareCloudJobEnvironment(request.jobId);
  await pullTursoTargets(tursoTargets);
  const tursoDebouncedPush =
    await startCloudAgentTursoDebouncedPush(tursoTargets);
  const writerDebouncedPush = await startCloudAppWriterDebouncedPush();

  return {
    runRoot,
    paprHome,
    tursoTargets,
    finish: async (finishOptions?: { deleteWorkspace?: boolean }) => {
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
        const outcome = await pushTursoTargets(tursoTargets);
        if (!outcome.ok) {
          syncSucceeded = false;
          retainSandbox = outcome.retainSandbox;
          throw new Error(
            `Turso sync did not complete for cloud agent run. ${outcome.failures.join("; ")}`,
          );
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
          retainSandbox = tursoTargets.some((target) =>
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
