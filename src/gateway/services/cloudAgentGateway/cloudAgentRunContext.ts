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
import {
  pullLinkedSourceFromCloud,
  pushLinkedSourceToCloud,
  type TursoBookendTarget,
} from "./syncJobTursoBookends.js";
import type { CloudAgentRunRequest, CloudTursoSource } from "./types.js";

interface CloudRunHandle {
  runRoot: string;
  finish: () => Promise<void>;
}

function resolveTursoBookendTargets(
  request: CloudAgentRunRequest,
  paprHome: string,
): TursoBookendTarget[] {
  const byKey = new Map<string, TursoBookendTarget>();

  const addSource = (source: CloudTursoSource): void => {
    const dbPath = rewritePaprPathForCloudRun(source.dbPath, paprHome);
    const syncKey = source.syncKey;
    if (!syncKey || byKey.has(syncKey)) {
      return;
    }
    byKey.set(syncKey, {
      syncKey,
      dbPath,
      tursoUrl: source.databaseUrl,
      authToken: source.authToken,
    });
  };

  if (request.tursoSources?.length) {
    for (const source of request.tursoSources) {
      addSource(source);
    }
  } else if (request.turso) {
    const jobDbPath = path.join(paprHome, "Jobs", request.turso.jobId, "data", "data.db");
    byKey.set(request.turso.jobId, {
      syncKey: request.turso.jobId,
      dbPath: jobDbPath,
      tursoUrl: request.turso.databaseUrl,
      authToken: request.turso.authToken,
    });
  }

  return [...byKey.values()];
}

export async function beginCloudAgentRun(
  request: CloudAgentRunRequest,
): Promise<CloudRunHandle> {
  const runRoot = path.join(os.tmpdir(), "papr-cloud-run", request.runId);
  const paprHome = path.join(runRoot, "Papr");
  const previousPaprHome = process.env.PAPR_HOME;
  const previousHome = process.env.HOME;
  const previousJobDir = process.env.JOB_DIR;
  const previousJobDb = process.env.JOB_DB;
  const previousAppId = process.env.APP_ID;
  const previousAppDb = process.env.APP_DB;
  const previousAppDbAlias = process.env.APP_DB_ALIAS;
  const previousVaultEnv = new Map<string, string | undefined>();

  await cloneUserRepoToPaprHome({
    targetPaprHome: paprHome,
    cloneUrl: request.repoCloneUrl,
    token: request.repoToken,
    branch: request.repoBranch,
  });

  process.env.PAPR_HOME = paprHome;
  process.env.HOME = runRoot;

  if (request.vaultKeys) {
    for (const [keyName, value] of Object.entries(request.vaultKeys)) {
      if (!value) continue;
      previousVaultEnv.set(keyName, process.env[keyName]);
      process.env[keyName] = value;
    }
  }

  const tursoTargets = resolveTursoBookendTargets(request, paprHome);
  for (const target of tursoTargets) {
    try {
      await fs.access(target.dbPath);
    } catch {
      await fs.mkdir(path.dirname(target.dbPath), { recursive: true });
      await fs.writeFile(target.dbPath, "");
    }
    await pullLinkedSourceFromCloud(target);
  }

  await reinitializeWorkspaceServicesForCloudRun({
    paprApiKey: request.paprApiKey,
  });
  await prepareCloudJobEnvironment(request.jobId);

  return {
    runRoot,
    finish: async () => {
      for (const target of tursoTargets) {
        await pushLinkedSourceToCloud(target);
      }

      if (previousPaprHome === undefined) delete process.env.PAPR_HOME;
      else process.env.PAPR_HOME = previousPaprHome;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousJobDir === undefined) delete process.env.JOB_DIR;
      else process.env.JOB_DIR = previousJobDir;
      if (previousJobDb === undefined) delete process.env.JOB_DB;
      else process.env.JOB_DB = previousJobDb;
      if (previousAppId === undefined) delete process.env.APP_ID;
      else process.env.APP_ID = previousAppId;
      if (previousAppDb === undefined) delete process.env.APP_DB;
      else process.env.APP_DB = previousAppDb;
      if (previousAppDbAlias === undefined) delete process.env.APP_DB_ALIAS;
      else process.env.APP_DB_ALIAS = previousAppDbAlias;

      for (const [keyName, previousValue] of previousVaultEnv.entries()) {
        if (previousValue === undefined) delete process.env[keyName];
        else process.env[keyName] = previousValue;
      }

      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
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
  return {
    jobId: request.jobId,
    runId: request.runId,
    prompt: request.prompt,
    provider: request.llmAuth.provider as Provider,
    model: request.model,
    allowedToolIds: request.allowedToolIds,
    maxTurns: request.maxTurns,
    authOverride: {
      apiKey: request.llmAuth.token,
      authType: request.llmAuth.authType,
    },
    paprApiKey: request.paprApiKey,
  };
}
