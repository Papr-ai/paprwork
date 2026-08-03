/**
 * Reload renderer state after org/namespace workspace switch.
 * Tabs restore first from SQLite; chats validate in background.
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
  reconcileChatTabsInStore,
} from "./persistedAppState";
import { ensureDefaultChatTab, resetDefaultChatTabGuardForTests } from "./ensureDefaultChatTab";

const LEGACY_TAB_STORAGE_KEY = "paprwork-tab-storage";
const GATEWAY_RETRY_MS = 200;
const TABS_LOAD_MAX_ATTEMPTS = 15;
const CHAT_LIST_RETRY_MS = 250;
const CHAT_LIST_MAX_ATTEMPTS = 12;

/** Coalesce rapid switches — always finish on the latest workspace. */
let workspaceReloadGeneration = 0;
let workspaceReloadChain: Promise<void> = Promise.resolve();
let workspaceBroadcastListenerAttached = false;

/** Test hook — reset coalescing state between unit tests. */
export function resetWorkspaceReloadForTests(): void {
  workspaceReloadGeneration = 0;
  workspaceReloadChain = Promise.resolve();
  workspaceBroadcastListenerAttached = false;
  resetDefaultChatTabGuardForTests();
}

function clearLegacyGlobalTabCache(): void {
  try {
    localStorage.removeItem(LEGACY_TAB_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

async function loadTabsForWorkspaceWithRetry(): Promise<boolean> {
  for (let attempt = 0; attempt < TABS_LOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await fetchPersistedAppStateFromGateway();
      if (snapshot) {
        applyPersistedAppStateToTabStore(snapshot);
        return true;
      }
    } catch (error) {
      if (attempt === TABS_LOAD_MAX_ATTEMPTS - 1) {
        console.error("[WorkspaceSwitch] Failed to reload tabs:", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_RETRY_MS));
  }
  return false;
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

  await reloadUiForWorkspaceSwitchInner(generation);

  if (generation !== workspaceReloadGeneration) {
    await runReloadForGeneration(workspaceReloadGeneration);
  }
}

export async function reloadUiForWorkspaceSwitch(): Promise<void> {
  const generation = ++workspaceReloadGeneration;
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
        window.dispatchEvent(new CustomEvent("papr-workspace-artifacts-ready"));
      }
    }
  }) as EventListener);
}

async function reloadUiForWorkspaceSwitchInner(generation: number): Promise<void> {
  attachWorkspaceSwitchBroadcastListener();
  clearLegacyGlobalTabCache();
  clearCloudPublishCache();
  resetDefaultChatTabGuardForTests();

  useArtifactsStore.getState().resetForWorkspaceSwitch();
  useSubAgentsStore.getState().resetForWorkspaceSwitch();
  resetChatListCache();
  useChatStore.getState().resetForWorkspaceSwitch();

  window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));

  // Brief clear — tab bar repopulates from SQLite on the next line (no chat:list wait).
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    activeLeftTab: null,
    activeRightTab: null,
    isSplitView: false,
    history: [],
    historyIndex: -1,
  });

  const tabsLoaded = await loadTabsForWorkspaceWithRetry();
  if (generation !== workspaceReloadGeneration) {
    return;
  }
  if (!tabsLoaded) {
    ensureDefaultChatTab();
  }

  window.dispatchEvent(new CustomEvent("papr-workspace-reload"));

  scheduleBackgroundChatValidation(generation);
}
