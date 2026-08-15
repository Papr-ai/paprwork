/**
 * Desktop workspace switch — re-point PAPR_HOME / PAPR_USER_DATA and reload services.
 */

import { paprApiKeyMatchesNamespaceBound } from "../../core/utils/paprApiKey.js";
import {
  applyActiveWorkspaceEnv,
  ensureWorkspaceLayout,
  readActiveWorkspacePointer,
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
  getWorkspaceService,
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

export type WorkspaceSwitchPhase =
  | "idle"
  | "preparing"
  | "core"
  | "artifacts"
  | "services"
  | "deferred"
  | "complete"
  | "error";

export interface WorkspaceSwitchStatus {
  active: boolean;
  phase: WorkspaceSwitchPhase;
  organizationId?: string;
  namespaceId?: string;
  error?: string;
  startedAt?: number;
}

export interface SwitchWorkspaceResult {
  success: true;
  pointer: ActiveWorkspacePointer;
  /** `switching` = accepted; heavy reinit continues in background. */
  status: "switching" | "ready";
}

let switchGeneration = 0;
let switchStatus: WorkspaceSwitchStatus = { active: false, phase: "idle" };
/** Keeps /health in "switching" while deferred cloud/vault work catches up (supervisor grace). */
let postSwitchMaintenanceUntil = 0;

const POST_SWITCH_HEALTH_GRACE_MS = 90_000;
/** Delay cloud git push backlog after namespace switch so /health stays responsive. */
const POST_SWITCH_CLOUD_SYNC_DEFER_MS = 60_000;

function isSwitchGenerationStale(generation: number): boolean {
  return generation !== switchGeneration;
}

function setSwitchStatus(patch: Partial<WorkspaceSwitchStatus>): void {
  switchStatus = { ...switchStatus, ...patch };
}

export function getWorkspaceSwitchStatus(): WorkspaceSwitchStatus {
  return { ...switchStatus };
}

/** Health endpoint uses this to avoid supervisor SIGKILL during background switch. */
export function getWorkspaceSwitchHealthStatus(): "ok" | "switching" {
  if (switchStatus.active) {
    return "switching";
  }
  if (Date.now() < postSwitchMaintenanceUntil) {
    return "switching";
  }
  return "ok";
}

/** @internal test hook */
export function resetPostSwitchMaintenanceGraceForTests(): void {
  postSwitchMaintenanceUntil = 0;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function activateWorkspacePointer(
  input: SwitchWorkspaceInput,
): Promise<ActiveWorkspacePointer> {
  const pointer = await ensureWorkspaceLayout(input);
  applyActiveWorkspaceEnv(pointer);
  return pointer;
}

/** Cancel in-flight streams quickly — must stay fast enough for /health to respond. */
async function cancelActiveAgentStreamsQuick(): Promise<void> {
  try {
    await getAgentStreamRegistry().cancelAllRunningStreams(
      "Workspace switch — stream aborted",
    );
  } catch (error) {
    console.warn(
      "[WorkspaceSwitch] Failed to cancel active streams:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function abortAllActiveAgentStreams(): Promise<void> {
  await cancelActiveAgentStreamsQuick();
  try {
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
  await yieldEventLoop();

  const { clearWikiHomeRemoteCache } = await import(
    "./KnowledgeGraphWikiService.js"
  );
  clearWikiHomeRemoteCache();
  const { clearMemoryPreviewCache } = await import("./MemoryPreviewCache.js");
  await clearMemoryPreviewCache();

  resetCommunityCatalogServiceForWorkspaceSwitch();
  resetPlanServiceForWorkspaceSwitch();
  resetSkillServiceForWorkspaceSwitch();
  resetWorkspaceServiceForWorkspaceSwitch();
  resetSubAgentServiceForWorkspaceSwitch();
  resetDocumentServiceForWorkspaceSwitch();
  resetDatabaseRegistryForWorkspaceSwitch();
  resetJobRunHistoryForWorkspaceSwitch();
  await yieldEventLoop();

  await resetCodeIndexingForWorkspaceSwitch();
  resetToolCaptureLedgerForWorkspaceSwitch();
  await yieldEventLoop();

  resetJobsServiceSingletonForTests();
  resetAppServiceSingletonForTests();
  await yieldEventLoop();

  resetAgentServiceSingletonForTests();
  await resetStorageManagerSingleton();
  resetAppStateStorageSingleton();
  await yieldEventLoop();
}

async function initializePathBoundServices(): Promise<void> {
  await initializeWorkspaceService();
  // Built-in agent jobs are scoped to the active namespace's jobs.json.
  await getWorkspaceService().ensureSleepJob();
  await getWorkspaceService().ensureWikiWriterJob();
  await initializeDocumentService();
  await initializeSkillService();
  await initializeSubAgentService();
  await initializePlanService();
  await initializeDatabaseRegistry();
}

async function runPostMigrationPathRepairIfNeeded(input?: {
  runPostMigrationPathRepair?: boolean;
  scopePaprHome?: string;
}): Promise<void> {
  if (!input?.runPostMigrationPathRepair) {
    return;
  }
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

/** Phased init after pointer reset — yields between phases so /health stays responsive. */
async function initializeWorkspaceServicesPhased(input?: {
  paprApiKey?: string;
  userDataPath?: string;
  runPostMigrationPathRepair?: boolean;
  scopePaprHome?: string;
  onPhase?: (phase: WorkspaceSwitchPhase) => void;
  isStale?: () => boolean;
}): Promise<void> {
  if (input?.isStale?.()) {
    return;
  }

  await runPostMigrationPathRepairIfNeeded(input);
  await yieldEventLoop();
  if (input?.isStale?.()) {
    return;
  }

  const paprApiKey = input?.paprApiKey ?? (await getPaprApiKey()) ?? undefined;

  input?.onPhase?.("core");
  await initializeAgentService({
    mode: paprApiKey ? "hybrid" : "local",
    paprApiKey,
    userDataPath: input?.userDataPath,
    openaiApiKey: undefined,
  });
  if (input?.isStale?.()) {
    return;
  }
  broadcast({ type: "workspace:switch-phase", data: { phase: "core" } });
  await yieldEventLoop();
  if (input?.isStale?.()) {
    return;
  }

  input?.onPhase?.("artifacts");
  await Promise.all([initializeAppService(), initializeDocumentService()]);
  if (input?.isStale?.()) {
    return;
  }
  broadcast({ type: "workspace:switch-phase", data: { phase: "artifacts" } });
  await yieldEventLoop();
  if (input?.isStale?.()) {
    return;
  }

  input?.onPhase?.("services");
  await initializeJobsService();
  await initializePathBoundServices();
  if (input?.isStale?.()) {
    return;
  }
  broadcast({ type: "workspace:switch-phase", data: { phase: "services" } });
  await yieldEventLoop();

  const truncationSettings = await refreshToolResultTruncationSettings();
  console.log(
    `[WorkspaceSwitch] Tool truncation loaded from ${process.env.PAPR_HOME ?? "Papr"}/data/settings.json` +
      (truncationSettings.disableAllTruncation ? " (truncation disabled)" : ""),
  );
}

/** Full reset + reinit (tests, migration flows that need synchronous completion). */
export async function reinitializeWorkspaceServices(input?: {
  paprApiKey?: string;
  userDataPath?: string;
  runPostMigrationPathRepair?: boolean;
  scopePaprHome?: string;
  onPhase?: (phase: WorkspaceSwitchPhase) => void;
}): Promise<void> {
  await resetPathBoundSingletons();
  await yieldEventLoop();
  await initializeWorkspaceServicesPhased(input);
}

async function restartCloudSyncIfEnabled(): Promise<void> {
  if (process.env.CLOUD_SYNC_ENABLED === "false") {
    return;
  }
  await resetCloudSyncServiceForWorkspaceSwitch();
  const cloudSync = initializeCloudSyncService();
  cloudSync.deferQueueProcessingUntil(Date.now() + POST_SWITCH_CLOUD_SYNC_DEFER_MS);
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

  vault.syncForWorkspaceSwitch();
  console.log("[WorkspaceSwitch] Vault re-sync scheduled for active workspace");
}

/** Update Papr API key in gateway env/cache and reinitialize memory storage. */
export async function applyGatewayPaprApiKey(apiKey: string): Promise<void> {
  const pointer = readActiveWorkspacePointer();
  if (
    pointer &&
    !paprApiKeyMatchesNamespaceBound(
      apiKey,
      pointer.organizationId,
      pointer.namespaceId,
    )
  ) {
    console.warn(
      "[WorkspaceSwitch] Ignoring Papr API key update — wrong org/namespace for active workspace",
    );
    return;
  }

  process.env.PAPR_API_KEY = apiKey;
  clearKeyCache("PAPR_API_KEY");
  invalidatePaprUserIdCache();
  getCustomKeysService().invalidateCache();

  const bridge = getTursoSyncBridge();
  if (bridge) {
    bridge.invalidateCredentialsCache();
  }

  await resetStorageManagerSingleton();
  resetAgentServiceSingletonForTests();
  await initializeAgentService({
    mode: "hybrid",
    paprApiKey: apiKey,
  });

  const { ensureIndexingStarted } = await import("./CodeIndexingService.js");
  void ensureIndexingStarted(apiKey).catch((error: unknown) => {
    console.warn(
      "[WorkspaceSwitch] Code indexing restart after API key update failed:",
      error instanceof Error ? error.message : error,
    );
  });
}

async function finishWorkspaceSwitchInBackground(
  input: SwitchWorkspaceInput,
  pointer: ActiveWorkspacePointer,
  generation: number,
): Promise<void> {
  try {
    if (isSwitchGenerationStale(generation)) {
      return;
    }

    await resetPathBoundSingletons();
    if (isSwitchGenerationStale(generation)) {
      return;
    }

    await initializeWorkspaceServicesPhased({
      paprApiKey: input.paprApiKey,
      runPostMigrationPathRepair: input.runPostMigrationPathRepair,
      scopePaprHome: input.runPostMigrationPathRepair ? pointer.paprHome : undefined,
      isStale: () => isSwitchGenerationStale(generation),
      onPhase: (phase) => {
        if (isSwitchGenerationStale(generation)) {
          return;
        }
        setSwitchStatus({ phase });
      },
    });
    if (isSwitchGenerationStale(generation)) {
      return;
    }

    getCustomKeysService().invalidateCache();

    broadcast({ type: "app:list-updated" });

    setSwitchStatus({ active: false, phase: "complete" });
    broadcast({ type: "workspace:switch-complete", data: { pointer } });
    console.log(
      `[WorkspaceSwitch] Background switch complete: org=${pointer.organizationId} ns=${pointer.namespaceId}`,
    );

    runDeferredWorkspaceSwitchMaintenance(pointer);
  } catch (error) {
    if (isSwitchGenerationStale(generation)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[WorkspaceSwitch] Background switch failed:", message);
    setSwitchStatus({ active: false, phase: "error", error: message });
    broadcast({ type: "workspace:switch-error", data: { error: message } });
  }
}

export async function switchActiveWorkspace(
  input: SwitchWorkspaceInput,
): Promise<SwitchWorkspaceResult> {
  const generation = ++switchGeneration;
  const superseding = switchStatus.active;

  if (superseding) {
    console.log(
      `[WorkspaceSwitch] Superseding in-flight switch → org=${input.organizationId} ns=${input.namespaceId}`,
    );
  }

  setSwitchStatus({
    active: true,
    phase: "preparing",
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    error: undefined,
    startedAt: Date.now(),
  });

  try {
    await cancelActiveAgentStreamsQuick();
    const pointer = await activateWorkspacePointer(input);
    // Point tab SQLite at the new workspace before renderer reload can load tabs.
    resetAppStateStorageSingleton();
    if (input.paprApiKey) {
      process.env.PAPR_API_KEY = input.paprApiKey;
    }
    clearKeyCache("PAPR_API_KEY");
    invalidatePaprUserIdCache();

    broadcast({
      type: "workspace:switch-started",
      data: {
        organizationId: input.organizationId,
        namespaceId: input.namespaceId,
      },
    });

    void finishWorkspaceSwitchInBackground(input, pointer, generation);

    return { success: true, pointer, status: "switching" };
  } catch (error) {
    if (generation === switchGeneration) {
      setSwitchStatus({ active: false, phase: "error" });
    }
    throw error;
  }
}

/** Cloud sync, Turso, and vault — not required before UI can use the new workspace. */
function runDeferredWorkspaceSwitchMaintenance(pointer: ActiveWorkspacePointer): void {
  postSwitchMaintenanceUntil = Date.now() + POST_SWITCH_HEALTH_GRACE_MS;

  void (async () => {
    try {
      await refreshTursoForWorkspaceSwitch();
      await restartCloudSyncIfEnabled();
      await refreshVaultForWorkspaceSwitch();

      const runningSync = getCloudSyncService();
      console.log(
        `[WorkspaceSwitch] Deferred maintenance complete: org=${pointer.organizationId} ns=${pointer.namespaceId} home=${pointer.paprHome}` +
          (runningSync ? " (cloud sync restarted)" : "") +
          (getTursoSyncBridge() ? " (turso refreshed)" : "") +
          (getVaultSyncService() ? " (vault re-synced)" : ""),
      );
    } catch (error) {
      console.warn(
        "[WorkspaceSwitch] Deferred maintenance failed:",
        error instanceof Error ? error.message : error,
      );
    }
  })();
}
