/**
 * Reload renderer state after org/namespace workspace switch.
 *
 * Tab lifecycle:
 * - Leaving a workspace: flushWorkspaceStateToGateway() saves the current tab bar to that workspace's SQLite.
 * - Entering a workspace: reload once from SQLite after gateway finishes switching (AppStateStorage path).
 * - After switch completes: user open/close tab changes persist via debounced save; no further SQLite restores.
 * - Next switch back: flushes current state, then restores whatever was saved for that workspace.
 */

import { resetChatListCache } from "../hooks/useChat";
import { useArtifactsStore, type Artifact } from "../stores/artifactsStore";
import { useChatStore } from "../stores/chatStore";
import { useSubAgentsStore } from "../stores/subAgentsStore";
import { useTabStore } from "../stores/tabStore";
import { gateway } from "../src/lib/gateway";
import type { ChatMetadata } from "../types/chat";
import { clearCloudPublishCache } from "../utils/cloudPublishCache";
import { clearCommunityCatalogCache } from "../utils/communityCatalogCache";
import {
  applyPersistedAppStateToTabStore,
  fetchPersistedAppStateFromGateway,
  flushWorkspaceStateToGateway,
  normalizeTabHierarchy,
  type WorkspaceEntityIdSets,
} from "./persistedAppState";
import { ensureSettingsTab } from "./ensureSettingsTab";
import { resetDefaultChatTabGuardForTests } from "./ensureDefaultChatTab";
import {
  beginWorkspaceSwitchOverlay,
  endWorkspaceSwitchOverlay,
  resetWorkspaceSwitchOverlayForTests,
  setWorkspaceSwitchOverlayPhase,
  type WorkspaceSwitchOverlayPhase,
} from "./workspaceSwitchOverlay";
import {
  buildWorkspaceUiCacheKey,
  clearWorkspaceUiCacheForTests,
  getActiveWorkspaceUiCacheKey,
  parseWorkspaceUiCacheKey,
  readWorkspaceUiCache,
  setActiveWorkspaceUiCacheKey,
  writeWorkspaceUiCache,
} from "./workspaceUiCache";
import {
  readProfileSidebarCache,
  writeProfileSidebarCache,
} from "../utils/profileSidebarCache";
import {
  fetchGatewayWorkspaceSwitchStatus,
  isGatewayWorkspaceSwitchComplete,
} from "./workspaceSwitchStatus";

const LEGACY_TAB_STORAGE_KEY = "paprwork-tab-storage";
const GATEWAY_RETRY_MS = 250;
const SWITCH_STATUS_POLL_MS = 250;
const SWITCH_STATUS_POLL_MAX_ATTEMPTS = 120;
/** Gateway may still be resetting AppStateStorage during early switch — allow ~15s. */
const TABS_LOAD_MAX_ATTEMPTS = 60;
const CHAT_LIST_RETRY_MS = 250;
const CHAT_LIST_MAX_ATTEMPTS = 12;
/** If switch-complete never arrives (gateway restart), load tabs anyway. */
const SWITCH_TAB_LOAD_FALLBACK_MS = 20_000;

/** Coalesce rapid switches — always finish on the latest workspace. */
let workspaceReloadGeneration = 0;
let workspaceReloadChain: Promise<void> = Promise.resolve();
let workspaceBroadcastListenerAttached = false;
let workspaceSwitchReloading = false;
/** Set while waiting for gateway switch-complete before loading workspace tabs. */
let awaitingSwitchTabRecovery: number | null = null;
const reloadWaitForGatewayByGeneration = new Map<number, boolean>();
const reloadTargetWorkspaceKeyByGeneration = new Map<number, string>();
const reloadLabelsByGeneration = new Map<
  number,
  { organizationName?: string; namespaceName?: string }
>();

export interface ReloadWorkspaceSwitchOptions {
  /**
   * Org/namespace switches: defer SQLite tab load until gateway broadcasts
   * workspace:switch-complete (AppStateStorage must point at the new workspace first).
   */
  waitForGateway?: boolean;
  /** Target workspace for cache hydration (orgId:namespaceId). */
  targetWorkspaceKey?: string;
  organizationName?: string;
  namespaceName?: string;
}

/** True while tabs/stores are being reset and reloaded for a workspace switch. */
export function isWorkspaceSwitchReloading(): boolean {
  // Also block persistence while waiting for gateway switch-complete — otherwise
  // ensureSettingsTab() triggers a debounced save that can overwrite the target
  // workspace's SQLite tab rows with only the Settings tab before restore runs.
  return workspaceSwitchReloading || awaitingSwitchTabRecovery !== null;
}

/** Test hook — reset coalescing state between unit tests. */
export function resetWorkspaceReloadForTests(): void {
  workspaceReloadGeneration = 0;
  workspaceReloadChain = Promise.resolve();
  workspaceBroadcastListenerAttached = false;
  workspaceSwitchReloading = false;
  awaitingSwitchTabRecovery = null;
  reloadWaitForGatewayByGeneration.clear();
  reloadTargetWorkspaceKeyByGeneration.clear();
  reloadLabelsByGeneration.clear();
  clearWorkspaceUiCacheForTests();
  resetDefaultChatTabGuardForTests();
  resetWorkspaceSwitchOverlayForTests();
}

export { parseWorkspaceSwitchLabels } from "./workspaceSwitchOverlay";

/** Parse org/namespace ids from papr org/namespace switch DOM events. */
export function parseWorkspaceKeyFromSwitchEvent(
  detail: unknown,
): string | undefined {
  if (!detail || typeof detail !== "object") {
    return undefined;
  }
  const record = detail as Record<string, unknown>;
  const organizationId =
    typeof record.parseOrganizationId === "string"
      ? record.parseOrganizationId
      : typeof record.organizationId === "string"
        ? record.organizationId
        : undefined;
  const namespaceId =
    typeof record.namespaceId === "string" ? record.namespaceId : undefined;
  if (!organizationId || !namespaceId) {
    return undefined;
  }
  return buildWorkspaceUiCacheKey(organizationId, namespaceId);
}

function snapshotCurrentWorkspaceToCache(): void {
  const key = getActiveWorkspaceUiCacheKey();
  if (!key) {
    return;
  }
  const {
    tabs,
    activeTabId,
    splitRatio,
    splitRatios,
    history,
    historyIndex,
  } = useTabStore.getState();
  const artifacts = useArtifactsStore.getState().artifacts;
  writeWorkspaceUiCache(key, {
    tabs: normalizeTabHierarchy(tabs),
    activeTabId,
    splitRatio,
    splitRatios,
    history,
    historyIndex,
    artifacts,
  });
}

function hydrateWorkspaceFromCache(targetKey: string): boolean {
  const cached = readWorkspaceUiCache(targetKey);
  if (!cached) {
    return false;
  }
  applyPersistedAppStateToTabStore({
    tabs: cached.tabs,
    activeTabId: cached.activeTabId,
    splitRatio: cached.splitRatio,
    splitRatios: cached.splitRatios,
    history: cached.history,
    historyIndex: cached.historyIndex,
  });
  // Artifacts always reload from gateway — cache is tabs-only to avoid wrong My Apps / team apps.
  setActiveWorkspaceUiCacheKey(targetKey);
  console.log(
    `[WorkspaceSwitch] Hydrated tab bar from cache (${cached.tabs.length} tabs)`,
  );
  return true;
}

function clearLegacyGlobalTabCache(): void {
  try {
    localStorage.removeItem(LEGACY_TAB_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

/** Restore tab bar from workspace SQLite. Returns count of non-settings tabs loaded/applied. */
async function loadTabsForWorkspaceWithRetry(
  targetWorkspaceKey?: string,
  entityIds?: WorkspaceEntityIdSets,
): Promise<number> {
  for (let attempt = 0; attempt < TABS_LOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await fetchPersistedAppStateFromGateway();
      if (snapshot) {
        applyPersistedAppStateToTabStore(snapshot, {
          ...entityIds,
          emptyActiveTabFallback: "none",
        });
        if (targetWorkspaceKey) {
          setActiveWorkspaceUiCacheKey(targetWorkspaceKey);
          const {
            tabs,
            activeTabId,
            splitRatio,
            splitRatios,
            history,
            historyIndex,
          } = useTabStore.getState();
          const artifacts = useArtifactsStore.getState().artifacts;
          writeWorkspaceUiCache(targetWorkspaceKey, {
            tabs: normalizeTabHierarchy(tabs),
            activeTabId,
            splitRatio,
            splitRatios,
            history,
            historyIndex,
            artifacts,
          });
        }
        return countNonSettingsTabs(useTabStore.getState().tabs);
      }
    } catch (error) {
      if (attempt === TABS_LOAD_MAX_ATTEMPTS - 1) {
        console.error("[WorkspaceSwitch] Failed to reload tabs:", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_RETRY_MS));
  }
  return 0;
}

function countNonSettingsTabs(
  tabs: ReturnType<typeof useTabStore.getState>["tabs"],
): number {
  return tabs.filter((tab) => tab.type !== "settings").length;
}

/** Load workspace apps/documents into artifacts store (My Apps + tab validation). */
async function loadArtifactsForWorkspaceWithRetry(): Promise<boolean> {
  for (let attempt = 0; attempt < CHAT_LIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const [docsResult, appsResult] = await Promise.allSettled([
        gateway.send("document:list"),
        gateway.send("app:list", {}, { timeoutMs: 90_000 }),
      ]);

      const documents =
        docsResult.status === "fulfilled"
          ? ((docsResult.value.data as Artifact[]) ?? [])
          : [];
      const apps =
        appsResult.status === "fulfilled"
          ? ((appsResult.value.data as Artifact[]) ?? [])
          : [];

      if (docsResult.status === "fulfilled" || appsResult.status === "fulfilled") {
        useArtifactsStore.getState().setArtifacts([...documents, ...apps]);
        return true;
      }
    } catch (error) {
      if (attempt === CHAT_LIST_MAX_ATTEMPTS - 1) {
        console.error("[WorkspaceSwitch] Failed to reload artifacts:", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CHAT_LIST_RETRY_MS));
  }
  return false;
}

function buildEntityIdSetsFromStores(): WorkspaceEntityIdSets {
  const chats = useChatStore.getState().chats;
  const artifacts = useArtifactsStore.getState().artifacts;
  return {
    validChatIds: new Set(chats.map((chat) => chat.id)),
    validAppIds: new Set(
      artifacts.filter((item) => item.type === "app").map((item) => item.id),
    ),
    validDocumentIds: new Set(
      artifacts
        .filter((item) => item.type === "document")
        .map((item) => item.id),
    ),
  };
}

/** Load entities from gateway, then restore tabs pruned to the active workspace. */
async function restoreWorkspaceTabsAndEntities(
  generation: number,
  targetWorkspaceKey?: string,
): Promise<number> {
  if (generation !== workspaceReloadGeneration) {
    return 0;
  }

  await Promise.all([
    loadArtifactsForWorkspaceWithRetry(),
    loadChatsForWorkspaceWithRetry(),
  ]);

  if (generation !== workspaceReloadGeneration) {
    return 0;
  }

  const entityIds = buildEntityIdSetsFromStores();
  return loadTabsForWorkspaceWithRetry(targetWorkspaceKey, entityIds);
}

/** Load workspace tabs from SQLite once gateway AppStateStorage is on the new workspace. */
async function applyWorkspaceTabsAfterGatewayReady(
  generation: number,
): Promise<void> {
  if (generation !== workspaceReloadGeneration) {
    return;
  }
  if (awaitingSwitchTabRecovery !== generation) {
    return;
  }

  const targetWorkspaceKey = reloadTargetWorkspaceKeyByGeneration.get(generation);

  const loaded = await restoreWorkspaceTabsAndEntities(
    generation,
    targetWorkspaceKey,
  );
  awaitingSwitchTabRecovery = null;
  if (generation !== workspaceReloadGeneration) {
    return;
  }

  if (loaded > 0) {
    console.log(
      `[WorkspaceSwitch] Restored ${loaded} workspace tab(s) after gateway switch complete`,
    );
  }
}

function getSwitchCompleteOptionsForGeneration(
  generation: number,
): { targetOrganizationId?: string; targetNamespaceId?: string } {
  const targetWorkspaceKey = reloadTargetWorkspaceKeyByGeneration.get(generation);
  if (!targetWorkspaceKey) {
    return {};
  }
  const parsed = parseWorkspaceUiCacheKey(targetWorkspaceKey);
  if (!parsed) {
    return {};
  }
  return {
    targetOrganizationId: parsed.organizationId,
    targetNamespaceId: parsed.namespaceId,
  };
}

function applySwitchLabelsToProfileCache(
  labels: { organizationName?: string; namespaceName?: string } | undefined,
): void {
  if (!labels?.organizationName && !labels?.namespaceName) {
    return;
  }
  const existing = readProfileSidebarCache();
  writeProfileSidebarCache({
    name: existing?.name ?? "",
    email: existing?.email ?? "",
    imageUrl: existing?.imageUrl ?? "",
    plan: existing?.plan ?? "",
    organizationName: labels.organizationName ?? existing?.organizationName ?? "",
    namespaceName: labels.namespaceName ?? existing?.namespaceName ?? "",
    workspaceName: existing?.workspaceName ?? "",
  });
  window.dispatchEvent(
    new CustomEvent("papr-workspace-labels-updated", { detail: labels }),
  );
}

async function completeWorkspaceSwitchReload(generation: number): Promise<void> {
  if (generation !== workspaceReloadGeneration) {
    return;
  }
  await applyWorkspaceTabsAfterGatewayReady(generation);
  if (generation !== workspaceReloadGeneration) {
    return;
  }
  endWorkspaceSwitchOverlay();
  applySwitchLabelsToProfileCache(reloadLabelsByGeneration.get(generation));
  window.dispatchEvent(new CustomEvent("papr-workspace-reload"));
  window.dispatchEvent(new CustomEvent("papr-workspace-switch-complete"));
  scheduleDeferredWorkspaceWarmup();
}

async function catchUpWorkspaceSwitchCompleteIfNeeded(
  generation: number,
): Promise<void> {
  if (generation !== workspaceReloadGeneration) {
    return;
  }
  if (awaitingSwitchTabRecovery !== generation) {
    return;
  }

  const status = await fetchGatewayWorkspaceSwitchStatus();
  if (
    !status ||
    !isGatewayWorkspaceSwitchComplete(
      status,
      getSwitchCompleteOptionsForGeneration(generation),
    )
  ) {
    return;
  }

  console.log(
    "[WorkspaceSwitch] Gateway switch already complete — catching up UI reload",
  );
  await completeWorkspaceSwitchReload(generation);
}

function scheduleSwitchStatusCatchUp(generation: number): void {
  void (async () => {
    for (let attempt = 0; attempt < SWITCH_STATUS_POLL_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, SWITCH_STATUS_POLL_MS));
      if (generation !== workspaceReloadGeneration) {
        return;
      }
      if (awaitingSwitchTabRecovery !== generation) {
        return;
      }
      await catchUpWorkspaceSwitchCompleteIfNeeded(generation);
      if (awaitingSwitchTabRecovery !== generation) {
        return;
      }
    }
  })();
}

function scheduleSwitchTabLoadFallback(generation: number): void {
  void (async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, SWITCH_TAB_LOAD_FALLBACK_MS),
    );
    if (generation !== workspaceReloadGeneration) {
      return;
    }
    if (awaitingSwitchTabRecovery !== generation) {
      return;
    }
    console.warn(
      "[WorkspaceSwitch] switch-complete timeout — loading tabs from SQLite",
    );
    await completeWorkspaceSwitchReload(generation);
  })();
}

/** Begin overlay + UI reset before main/gateway switch IPC (Settings picker). */
export async function prepareWorkspaceSwitchReload(
  options?: ReloadWorkspaceSwitchOptions,
): Promise<void> {
  // Must flush while the leaving workspace's tabs are still in the tab store.
  // reloadUiForWorkspaceSwitchInner clears tabs before gateway IPC runs.
  await flushWorkspaceStateToGateway();
  await reloadUiForWorkspaceSwitch({
    ...options,
    waitForGateway: true,
  });
}

/** Cancel in-flight reload when workspace switch IPC fails. */
export function abortWorkspaceSwitchReload(): void {
  workspaceReloadGeneration += 1;
  awaitingSwitchTabRecovery = null;
  endWorkspaceSwitchOverlay();
}

async function loadChatsForWorkspaceWithRetry(): Promise<Set<string>> {
  const validChatIds = new Set<string>();

  for (let attempt = 0; attempt < CHAT_LIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await gateway.send("chat:list");
      const chatsList = response.data as Array<
        Pick<ChatMetadata, "id" | "title" | "createdAt" | "updatedAt"> &
          Partial<Pick<ChatMetadata, "messageCount" | "isStreaming" | "hasUnread">>
      >;
      if (Array.isArray(chatsList)) {
        const chats: ChatMetadata[] = chatsList.map((chat) => ({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          messageCount: chat.messageCount ?? 0,
          isStreaming: chat.isStreaming,
          hasUnread: chat.hasUnread,
        }));
        useChatStore.getState().setChats(chats);
        for (const chat of chats) {
          validChatIds.add(chat.id);
        }
        return validChatIds;
      }
    } catch (error) {
      if (attempt === CHAT_LIST_MAX_ATTEMPTS - 1) {
        console.error("[WorkspaceSwitch] Failed to reload chats:", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CHAT_LIST_RETRY_MS));
  }

  return validChatIds;
}

async function runReloadForGeneration(generation: number): Promise<void> {
  if (generation !== workspaceReloadGeneration) {
    return;
  }

  const waitForGateway = reloadWaitForGatewayByGeneration.get(generation) ?? false;
  await reloadUiForWorkspaceSwitchInner(generation, waitForGateway);

  if (generation !== workspaceReloadGeneration) {
    await runReloadForGeneration(workspaceReloadGeneration);
  }
}

export async function reloadUiForWorkspaceSwitch(
  options?: ReloadWorkspaceSwitchOptions,
): Promise<void> {
  const generation = ++workspaceReloadGeneration;
  const waitForGateway = options?.waitForGateway === true;
  reloadWaitForGatewayByGeneration.set(generation, waitForGateway);
  if (options?.targetWorkspaceKey) {
    reloadTargetWorkspaceKeyByGeneration.set(generation, options.targetWorkspaceKey);
  }
  if (options?.organizationName || options?.namespaceName) {
    reloadLabelsByGeneration.set(generation, {
      organizationName: options.organizationName,
      namespaceName: options.namespaceName,
    });
  }
  awaitingSwitchTabRecovery = waitForGateway ? generation : null;

  workspaceReloadChain = workspaceReloadChain
    .then(() => runReloadForGeneration(generation))
    .catch((error: unknown) => {
      console.error("[WorkspaceSwitch] Reload chain error:", error);
    });
  return workspaceReloadChain;
}

/** Optional warm-up after gateway finishes background switch (non-blocking). */
function scheduleDeferredWorkspaceWarmup(): void {
  void (async () => {
    try {
      await useSubAgentsStore.getState().ensureLoaded();
    } catch (error) {
      console.warn("[WorkspaceSwitch] Deferred sub-agent reload skipped:", error);
    }
  })();
}

/** Listen for gateway background switch completion to warm caches. */
export function attachWorkspaceSwitchBroadcastListener(): void {
  if (workspaceBroadcastListenerAttached || typeof window === "undefined") {
    return;
  }
  workspaceBroadcastListenerAttached = true;

  window.addEventListener("gateway-broadcast", ((event: CustomEvent) => {
    const detail = event.detail as { type?: string; data?: unknown };
    if (detail?.type === "workspace:switch-complete") {
      void completeWorkspaceSwitchReload(workspaceReloadGeneration);
    }
    if (detail?.type === "workspace:switch-error") {
      endWorkspaceSwitchOverlay();
    }
    if (detail?.type === "workspace:switch-phase") {
      const phase =
        typeof detail.data === "object" &&
        detail.data !== null &&
        "phase" in detail.data
          ? String((detail.data as { phase: string }).phase)
          : undefined;
      if (
        phase === "core" ||
        phase === "artifacts" ||
        phase === "services"
      ) {
        setWorkspaceSwitchOverlayPhase(phase as WorkspaceSwitchOverlayPhase);
      }
      if (phase === "artifacts") {
        void loadArtifactsForWorkspaceWithRetry();
        window.dispatchEvent(new CustomEvent("papr-workspace-artifacts-ready"));
      }
    }
  }) as EventListener);
}

async function reloadUiForWorkspaceSwitchInner(
  generation: number,
  waitForGateway: boolean,
): Promise<void> {
  workspaceSwitchReloading = true;
  window.dispatchEvent(new CustomEvent("papr-workspace-switch-start"));
  const targetWorkspaceKey = reloadTargetWorkspaceKeyByGeneration.get(generation);
  const labels = reloadLabelsByGeneration.get(generation);
  if (waitForGateway) {
    beginWorkspaceSwitchOverlay(labels);
    applySwitchLabelsToProfileCache(labels);
  }
  try {
    attachWorkspaceSwitchBroadcastListener();
    clearLegacyGlobalTabCache();
    clearCloudPublishCache();
    clearCommunityCatalogCache();
    resetDefaultChatTabGuardForTests();

    snapshotCurrentWorkspaceToCache();
    if (targetWorkspaceKey) {
      setActiveWorkspaceUiCacheKey(targetWorkspaceKey);
    }

    useSubAgentsStore.getState().resetForWorkspaceSwitch();
    resetChatListCache();
    useChatStore.getState().resetForWorkspaceSwitch();

    window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));

    const hydratedFromCache =
      targetWorkspaceKey !== undefined &&
      hydrateWorkspaceFromCache(targetWorkspaceKey);

    if (!hydratedFromCache) {
      useArtifactsStore.getState().resetForWorkspaceSwitch();
      useTabStore.setState({
        tabs: [],
        activeTabId: null,
        activeLeftTab: null,
        activeRightTab: null,
        isSplitView: false,
        history: [],
        historyIndex: -1,
      });
    } else {
      // Tabs came from cache — still reload apps/docs from the new workspace.
      useArtifactsStore.getState().resetForWorkspaceSwitch();
    }

    if (waitForGateway) {
      console.log(
        "[WorkspaceSwitch] Waiting for gateway switch-complete before loading workspace tabs",
      );
      scheduleSwitchTabLoadFallback(generation);
      void catchUpWorkspaceSwitchCompleteIfNeeded(generation);
      scheduleSwitchStatusCatchUp(generation);
    } else {
      await restoreWorkspaceTabsAndEntities(generation, targetWorkspaceKey);
      if (generation !== workspaceReloadGeneration) {
        return;
      }
      awaitingSwitchTabRecovery = null;
      endWorkspaceSwitchOverlay();
      window.dispatchEvent(new CustomEvent("papr-workspace-reload"));
      window.dispatchEvent(new CustomEvent("papr-workspace-switch-complete"));
    }

    // User-initiated switch from Settings — stay on Profile while tabs reload.
    if (waitForGateway) {
      ensureSettingsTab({ section: "profile" });
    }
  } finally {
    workspaceSwitchReloading = false;
  }
}
