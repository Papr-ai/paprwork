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
import { useArtifactsStore } from "../stores/artifactsStore";
import { useChatStore } from "../stores/chatStore";
import { useSubAgentsStore } from "../stores/subAgentsStore";
import { useTabStore } from "../stores/tabStore";
import { gateway } from "../src/lib/gateway";
import type { ChatMetadata } from "../types/chat";
import { clearCloudPublishCache } from "../utils/cloudPublishCache";
import {
  applyPersistedAppStateToTabStore,
  fetchPersistedAppStateFromGateway,
  normalizeTabHierarchy,
  reconcileChatTabsInStore,
} from "./persistedAppState";
import { ensureSettingsTab } from "./ensureSettingsTab";
import { resetDefaultChatTabGuardForTests } from "./ensureDefaultChatTab";
import {
  buildWorkspaceUiCacheKey,
  clearWorkspaceUiCacheForTests,
  getActiveWorkspaceUiCacheKey,
  readWorkspaceUiCache,
  setActiveWorkspaceUiCacheKey,
  writeWorkspaceUiCache,
} from "./workspaceUiCache";

const LEGACY_TAB_STORAGE_KEY = "paprwork-tab-storage";
const GATEWAY_RETRY_MS = 250;
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

export interface ReloadWorkspaceSwitchOptions {
  /**
   * Org/namespace switches: defer SQLite tab load until gateway broadcasts
   * workspace:switch-complete (AppStateStorage must point at the new workspace first).
   */
  waitForGateway?: boolean;
  /** Target workspace for cache hydration (orgId:namespaceId). */
  targetWorkspaceKey?: string;
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
  clearWorkspaceUiCacheForTests();
  resetDefaultChatTabGuardForTests();
}

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
  useArtifactsStore.getState().setArtifacts(cached.artifacts);
  setActiveWorkspaceUiCacheKey(targetKey);
  console.log(
    `[WorkspaceSwitch] Hydrated UI from cache (${cached.tabs.length} tabs, ${cached.artifacts.length} artifacts)`,
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
): Promise<number> {
  for (let attempt = 0; attempt < TABS_LOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await fetchPersistedAppStateFromGateway();
      if (snapshot) {
        applyPersistedAppStateToTabStore(snapshot, {
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

  const loaded = await loadTabsForWorkspaceWithRetry(targetWorkspaceKey);
  awaitingSwitchTabRecovery = null;
  if (generation !== workspaceReloadGeneration) {
    return;
  }

  if (loaded > 0) {
    console.log(
      `[WorkspaceSwitch] Restored ${loaded} workspace tab(s) after gateway switch complete`,
    );
  }
  scheduleBackgroundChatValidation(generation);
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
    await applyWorkspaceTabsAfterGatewayReady(generation);
  })();
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

function scheduleBackgroundChatValidation(generation: number): void {
  void (async () => {
    const validChatIds = await loadChatsForWorkspaceWithRetry();
    if (generation !== workspaceReloadGeneration) {
      return;
    }
    if (validChatIds.size > 0) {
      reconcileChatTabsInStore(validChatIds);
    }
  })();
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
      void applyWorkspaceTabsAfterGatewayReady(workspaceReloadGeneration);
      scheduleDeferredWorkspaceWarmup();
      window.dispatchEvent(new CustomEvent("papr-workspace-switch-complete"));
    }
    if (detail?.type === "workspace:switch-phase") {
      const phase =
        typeof detail.data === "object" &&
        detail.data !== null &&
        "phase" in detail.data
          ? String((detail.data as { phase: string }).phase)
          : undefined;
      if (phase === "artifacts") {
        void applyWorkspaceTabsAfterGatewayReady(workspaceReloadGeneration);
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
  try {
    attachWorkspaceSwitchBroadcastListener();
    clearLegacyGlobalTabCache();
    clearCloudPublishCache();
    resetDefaultChatTabGuardForTests();

    snapshotCurrentWorkspaceToCache();

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
    }

    if (waitForGateway) {
      console.log(
        "[WorkspaceSwitch] Waiting for gateway switch-complete before loading workspace tabs",
      );
      scheduleSwitchTabLoadFallback(generation);
    } else {
      const tabsLoaded = await loadTabsForWorkspaceWithRetry(targetWorkspaceKey);
      if (generation !== workspaceReloadGeneration) {
        return;
      }
      if (tabsLoaded === 0) {
        awaitingSwitchTabRecovery = generation;
        console.log(
          "[WorkspaceSwitch] No tabs loaded yet — will retry when gateway switch completes",
        );
      } else {
        awaitingSwitchTabRecovery = null;
        scheduleBackgroundChatValidation(generation);
      }
    }

    // Stay on Settings (Profile / namespace picker) — workspace tabs load into the tab bar next.
    ensureSettingsTab({ section: "profile" });

    window.dispatchEvent(new CustomEvent("papr-workspace-reload"));
  } finally {
    workspaceSwitchReloading = false;
  }
}
