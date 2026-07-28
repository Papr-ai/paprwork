/**
 * Desktop workspace switch — re-point PAPR_HOME / PAPR_USER_DATA and reload services.
 */

import {
  applyActiveWorkspaceEnv,
  ensureWorkspaceLayout,
  migrateLegacyFlatPaprLayout,
  migrateLegacyUserDataRuntime,
  type ActiveWorkspacePointer,
} from "../../core/utils/paprWorkspace.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
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

export interface SwitchWorkspaceInput {
  organizationId: string;
  namespaceId: string;
  organizationName?: string;
  namespaceName?: string;
  paprApiKey?: string;
  /** Skip legacy ~/Papr migration (cloud ephemeral runs). */
  skipLegacyMigration?: boolean;
}

export interface SwitchWorkspaceResult {
  success: true;
  pointer: ActiveWorkspacePointer;
}

export async function activateWorkspacePointer(
  input: SwitchWorkspaceInput,
): Promise<ActiveWorkspacePointer> {
  const pointer = await ensureWorkspaceLayout(input);

  if (!input.skipLegacyMigration) {
    // One-time idempotent migrations only. Do NOT relocate data between namespaces on
    // every switch — that moved entire apps/documents/Jobs trees and blocked the UI for
    // minutes. Cross-namespace consolidation belongs in a one-time migration script.
    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      targetPaprHome: pointer.paprHome,
    });
    if (migrated) {
      console.log(
        `[WorkspaceSwitch] Migrated legacy Papr folders into ${pointer.paprHome}: ${migrated.movedPaths.join(", ")}`,
      );
    }

    const migratedUserData = await migrateLegacyUserDataRuntime({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      targetPaprHome: pointer.paprHome,
      targetUserDataPath: pointer.userDataPath,
    });
    if (migratedUserData) {
      console.log(
        `[WorkspaceSwitch] Migrated legacy runtime data into ${pointer.userDataPath}: ${migratedUserData.join(", ")}`,
      );
    }
  }

  applyActiveWorkspaceEnv(pointer);
  return pointer;
}

async function resetPathBoundSingletons(): Promise<void> {
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
  resetStorageManagerSingleton();
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
}): Promise<void> {
  await resetPathBoundSingletons();

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

export async function switchActiveWorkspace(
  input: SwitchWorkspaceInput,
): Promise<SwitchWorkspaceResult> {
  const pointer = await activateWorkspacePointer(input);
  await reinitializeWorkspaceServices({ paprApiKey: input.paprApiKey });
  getCustomKeysService().invalidateCache();
  void restartCloudSyncIfEnabled();
  void refreshTursoForWorkspaceSwitch();
  void refreshVaultForWorkspaceSwitch();

  const runningSync = getCloudSyncService();
  console.log(
    `[WorkspaceSwitch] Active workspace: org=${pointer.organizationId} ns=${pointer.namespaceId} home=${pointer.paprHome}` +
      (runningSync ? " (cloud sync restarted)" : "") +
      (getTursoSyncBridge() ? " (turso refreshed)" : "") +
      (getVaultSyncService() ? " (vault re-sync scheduled)" : ""),
  );

  broadcast({ type: "app:list-updated" });

  return { success: true, pointer };
}
