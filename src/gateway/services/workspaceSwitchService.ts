/**
 * Desktop workspace switch — re-point PAPR_HOME / PAPR_USER_DATA and reload services.
 */

import {
  applyActiveWorkspaceEnv,
  ensureWorkspaceLayout,
  type ActiveWorkspacePointer,
} from "../../core/utils/paprWorkspace.js";
import { getPaprApiKey, clearKeyCache } from "../utils/keyResolver.js";
import {
  initializeAppService,
  resetAppServiceSingletonForTests,
} from "./AppService.js";
import {
  initializeJobsService,
  resetJobsServiceSingletonForTests,
} from "./JobsService.js";
import {
  initializeAgentService,
  resetAgentServiceSingletonForTests,
} from "./AgentService.js";
import { resetStorageManagerSingleton } from "./StorageManager.js";
import { resetAppStateStorageSingleton } from "./storage/AppStateStorage.js";
import { refreshToolResultTruncationSettings } from "./agent/toolResultTruncationSettings.js";
import { getAgentStreamRegistry } from "./AgentStreamRegistry.js";
import { getAgentService } from "./AgentService.js";
import { resetDbRouterTursoCache } from "./appRuntime/DbRouter.js";
import { invalidatePaprUserIdCache } from "../utils/paprUserId.js";
import {
  getCloudSyncService,
  initializeCloudSyncService,
  resetCloudSyncServiceForWorkspaceSwitch,
} from "./CloudSyncService.js";
import {
  initializePlanService,
  resetPlanServiceForWorkspaceSwitch,
} from "./PlanService.js";
import {
  initializeSkillService,
  resetSkillServiceForWorkspaceSwitch,
} from "./SkillService.js";
import {
  initializeWorkspaceService,
  resetWorkspaceServiceForWorkspaceSwitch,
} from "./WorkspaceService.js";
import {
  initializeSubAgentService,
  resetSubAgentServiceForWorkspaceSwitch,
} from "./SubAgentService.js";
import {
  initializeDocumentService,
  resetDocumentServiceForWorkspaceSwitch,
} from "./DocumentService.js";
import {
  initializeDatabaseRegistry,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "./DatabaseRegistryService.js";
import { resetJobRunHistoryForWorkspaceSwitch } from "./jobs/JobRunHistory.js";
import { resetCodeIndexingForWorkspaceSwitch } from "./CodeIndexingService.js";
import { resetToolCaptureLedgerForWorkspaceSwitch } from "./toolCapture/ToolCaptureLedger.js";
import { broadcast } from "../websocket/index.js";
import { getCustomKeysService } from "./CustomKeysService.js";
import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import { getVaultSyncService } from "./VaultSyncService.js";
import { resetCommunityCatalogServiceForWorkspaceSwitch } from "./CommunityCatalogService.js";

export interface SwitchWorkspaceInput {
  organizationId: string;
  namespaceId: string;
  organizationName?: string;
  namespaceName?: string;
  paprApiKey?: string;
  /** Skip misplaced-target relocation (cloud ephemeral runs). */
  skipLegacyMigration?: boolean;
  /** Run path repair after consent migration, before app watchers restart. */
  runPostMigrationPathRepair?: boolean;
}

export interface SwitchWorkspaceResult {
  success: true;
  pointer: ActiveWorkspacePointer;
}

export async function activateWorkspacePointer(
  input: SwitchWorkspaceInput,
): Promise<ActiveWorkspacePointer> {
  const pointer = await ensureWorkspaceLayout(input);
  applyActiveWorkspaceEnv(pointer);
  return pointer;
}

async function abortAllActiveAgentStreams(): Promise<void> {
  try {
    await getAgentStreamRegistry().cancelAllRunningStreams(
      "Workspace switch — stream aborted",
    );
    await getAgentService().shutdown();
    console.log("[WorkspaceSwitch] Aborted active agent streams before switch");
  } catch (error) {
    console.warn(
      "[WorkspaceSwitch] Failed to abort active streams:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function resetPathBoundSingletons(): Promise<void> {
  await abortAllActiveAgentStreams();
  resetCommunityCatalogServiceForWorkspaceSwitch();
  resetPlanServiceForWorkspaceSwitch();
  resetSkillServiceForWorkspaceSwitch();
  resetWorkspaceServiceForWorkspaceSwitch();
  resetSubAgentServiceForWorkspaceSwitch();
  resetDocumentServiceForWorkspaceSwitch();
  resetDatabaseRegistryForWorkspaceSwitch();
  resetJobRunHistoryForWorkspaceSwitch();
  await resetCodeIndexingForWorkspaceSwitch();
  resetToolCaptureLedgerForWorkspaceSwitch();
  resetJobsServiceSingletonForTests();
  resetAppServiceSingletonForTests();
  resetAgentServiceSingletonForTests();
  await resetStorageManagerSingleton();
  resetAppStateStorageSingleton();
}

async function initializePathBoundServices(): Promise<void> {
  await initializeWorkspaceService();
  await initializeDocumentService();
  await initializeSkillService();
  await initializeSubAgentService();
  await initializePlanService();
  await initializeDatabaseRegistry();
}

export async function reinitializeWorkspaceServices(input?: {
  paprApiKey?: string;
  runPostMigrationPathRepair?: boolean;
  scopePaprHome?: string;
}): Promise<void> {
  await resetPathBoundSingletons();

  if (input?.runPostMigrationPathRepair) {
    const { runPostMigrationPathRepair, formatPostMigrationRepairSummary } =
      await import("./postMigrationPathRepair.js");
    const repairResult = await runPostMigrationPathRepair({
      dryRun: false,
      includeApps: true,
      delayMs: 0,
      scopePaprHome: input.scopePaprHome,
    });
    console.log(
      "[WorkspaceSwitch] Post-migration path repair:",
      formatPostMigrationRepairSummary(repairResult),
    );
  }

  const paprApiKey = input?.paprApiKey ?? (await getPaprApiKey()) ?? undefined;

  await Promise.all([initializeAppService(), initializeJobsService()]);
  await initializeAgentService({
    mode: paprApiKey ? "hybrid" : "local",
    paprApiKey,
    openaiApiKey: undefined,
  });
  await initializePathBoundServices();

  const truncationSettings = await refreshToolResultTruncationSettings();
  console.log(
    `[WorkspaceSwitch] Tool truncation loaded from ${process.env.PAPR_HOME ?? "Papr"}/data/settings.json` +
      (truncationSettings.disableAllTruncation ? " (truncation disabled)" : ""),
  );
}

async function restartCloudSyncIfEnabled(): Promise<void> {
  if (process.env.CLOUD_SYNC_ENABLED === "false") {
    return;
  }
  await resetCloudSyncServiceForWorkspaceSwitch();
  const cloudSync = initializeCloudSyncService();
  await cloudSync.initialize();
}

async function refreshTursoForWorkspaceSwitch(): Promise<void> {
  if (process.env.TURSO_SYNC_ENABLED === "false") {
    return;
  }

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  bridge.invalidateCredentialsCache();
  bridge.invalidateLinkedSourcesCache();
  resetDbRouterTursoCache();

  try {
    const { refreshTursoLinkedDbWatcher } = await import(
      "./TursoLinkedDbWatcher.js"
    );
    await refreshTursoLinkedDbWatcher();
    console.log("[WorkspaceSwitch] Turso linked-db watcher refreshed");
  } catch (err) {
    console.warn(
      "[WorkspaceSwitch] Turso watcher refresh failed:",
      (err as Error).message.slice(0, 120),
    );
  }
}

async function refreshVaultForWorkspaceSwitch(): Promise<void> {
  const vault = getVaultSyncService();
  if (!vault) {
    return;
  }

  try {
    await vault.syncForWorkspaceSwitch();
    console.log("[WorkspaceSwitch] Vault re-synced for active workspace");
  } catch (err) {
    console.warn(
      "[WorkspaceSwitch] Vault re-sync failed:",
      (err as Error).message.slice(0, 120),
    );
  }
}

/** Update Papr API key in gateway env/cache without reloading workspace services. */
export function applyGatewayPaprApiKey(apiKey: string): void {
  process.env.PAPR_API_KEY = apiKey;
  clearKeyCache("PAPR_API_KEY");

  const bridge = getTursoSyncBridge();
  if (bridge) {
    bridge.invalidateCredentialsCache();
  }
}

export async function switchActiveWorkspace(
  input: SwitchWorkspaceInput,
): Promise<SwitchWorkspaceResult> {
  const pointer = await activateWorkspacePointer(input);
  if (input.paprApiKey) {
    process.env.PAPR_API_KEY = input.paprApiKey;
  }
  clearKeyCache("PAPR_API_KEY");
  invalidatePaprUserIdCache();
  await reinitializeWorkspaceServices({
    paprApiKey: input.paprApiKey,
    runPostMigrationPathRepair: input.runPostMigrationPathRepair,
    scopePaprHome: input.runPostMigrationPathRepair ? pointer.paprHome : undefined,
  });
  getCustomKeysService().invalidateCache();

  broadcast({ type: "app:list-updated" });

  void runDeferredWorkspaceSwitchMaintenance(pointer).catch((error: unknown) => {
    console.warn(
      "[WorkspaceSwitch] Deferred maintenance failed:",
      error instanceof Error ? error.message : error,
    );
  });

  return { success: true, pointer };
}

/** Cloud sync, Turso, and vault — not required before UI can use the new workspace. */
async function runDeferredWorkspaceSwitchMaintenance(
  pointer: ActiveWorkspacePointer,
): Promise<void> {
  await restartCloudSyncIfEnabled();
  await refreshTursoForWorkspaceSwitch();
  await refreshVaultForWorkspaceSwitch();

  const runningSync = getCloudSyncService();
  console.log(
    `[WorkspaceSwitch] Deferred maintenance complete: org=${pointer.organizationId} ns=${pointer.namespaceId} home=${pointer.paprHome}` +
      (runningSync ? " (cloud sync restarted)" : "") +
      (getTursoSyncBridge() ? " (turso refreshed)" : "") +
      (getVaultSyncService() ? " (vault re-synced)" : ""),
  );
}
