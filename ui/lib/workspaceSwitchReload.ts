/**
 * Reload renderer state after org/namespace workspace switch.
 * Gateway reinitializes storage; the UI must drop cached chats/jobs/tabs.
 */

import { resetChatListCache } from "../hooks/useChat";
import { useArtifactsStore, type Artifact } from "../stores/artifactsStore";
import { useChatStore } from "../stores/chatStore";
import { useSubAgentsStore } from "../stores/subAgentsStore";
import { useTabStore } from "../stores/tabStore";
import { gateway } from "../src/lib/gateway";
import type { ChatMetadata } from "../types/chat";
import { clearCloudPublishCache } from "../utils/cloudPublishCache";
import { loadPersistedAppStateFromGateway } from "./persistedAppState";
import { ensureDefaultChatTab, resetDefaultChatTabGuardForTests } from "./ensureDefaultChatTab";

const LEGACY_TAB_STORAGE_KEY = "paprwork-tab-storage";

/** Coalesce org + namespace switch events that fire back-to-back into one reload. */
let workspaceReloadInFlight: Promise<void> | null = null;

/** Test hook — reset coalescing state between unit tests. */
export function resetWorkspaceReloadForTests(): void {
  workspaceReloadInFlight = null;
  resetDefaultChatTabGuardForTests();
}

function clearLegacyGlobalTabCache(): void {
  try {
    localStorage.removeItem(LEGACY_TAB_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

async function reloadArtifactsForWorkspace(): Promise<void> {
  try {
    const [docsResult, appsResult] = await Promise.allSettled([
      gateway.send("document:list"),
      gateway.send("app:list"),
    ]);

    const documents =
      docsResult.status === "fulfilled" && docsResult.value.success
        ? (docsResult.value.data as Artifact[]) || []
        : [];
    const apps =
      appsResult.status === "fulfilled" && appsResult.value.success
        ? (appsResult.value.data as Artifact[]) || []
        : [];

    if (docsResult.status === "rejected") {
      console.error("[WorkspaceSwitch] document:list failed:", docsResult.reason);
    } else if (docsResult.status === "fulfilled" && !docsResult.value.success) {
      console.error(
        "[WorkspaceSwitch] document:list error:",
        docsResult.value.error ?? "unknown error",
      );
    }

    if (appsResult.status === "rejected") {
      console.error("[WorkspaceSwitch] app:list failed:", appsResult.reason);
    } else if (appsResult.status === "fulfilled" && !appsResult.value.success) {
      console.error(
        "[WorkspaceSwitch] app:list error:",
        appsResult.value.error ?? "unknown error",
      );
    }

    useArtifactsStore.getState().setArtifacts([...documents, ...apps]);
  } catch (error) {
    console.error("[WorkspaceSwitch] Failed to reload artifacts:", error);
  }
}

async function reloadSubAgentsForWorkspace(): Promise<void> {
  useSubAgentsStore.getState().resetForWorkspaceSwitch();
  try {
    await useSubAgentsStore.getState().ensureLoaded();
  } catch (error) {
    console.error("[WorkspaceSwitch] Failed to reload sub-agents:", error);
  }
}

export async function reloadUiForWorkspaceSwitch(): Promise<void> {
  if (workspaceReloadInFlight) {
    return workspaceReloadInFlight;
  }

  workspaceReloadInFlight = reloadUiForWorkspaceSwitchInner().finally(() => {
    workspaceReloadInFlight = null;
  });
  return workspaceReloadInFlight;
}

async function reloadUiForWorkspaceSwitchInner(): Promise<void> {
  clearLegacyGlobalTabCache();
  clearCloudPublishCache();
  resetDefaultChatTabGuardForTests();

  // Drop tabs immediately so app/document views don't fetch stale entity IDs
  // against the new workspace while persisted tabs reload.
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    activeLeftTab: null,
    activeRightTab: null,
    isSplitView: false,
    history: [],
    historyIndex: -1,
  });

  useArtifactsStore.getState().resetForWorkspaceSwitch();

  resetChatListCache();
  useChatStore.getState().resetForWorkspaceSwitch();

  window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));

  let validChatIds = new Set<string>();
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
      validChatIds = new Set(chats.map((c) => c.id));
    }
  } catch (error) {
    console.error("[WorkspaceSwitch] Failed to reload chats:", error);
  }

  await Promise.all([
    reloadArtifactsForWorkspace(),
    reloadSubAgentsForWorkspace(),
  ]);

  const artifacts = useArtifactsStore.getState().artifacts;
  const validAppIds = new Set(
    artifacts.filter((item) => item.type === "app").map((item) => item.id),
  );
  const validDocumentIds = new Set(
    artifacts
      .filter((item) => item.type === "document")
      .map((item) => item.id),
  );

  try {
    await loadPersistedAppStateFromGateway({
      validChatIds,
      validAppIds,
      validDocumentIds,
    });
  } catch (error) {
    console.error("[WorkspaceSwitch] Failed to reload tabs:", error);
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      history: [],
      historyIndex: -1,
    });
  }

  if (!useTabStore.getState().activeTabId) {
    ensureDefaultChatTab();
  }

  // Notify hooks after tabs/chats are restored — avoids premature empty chat tabs
  // while gateway is still reinitializing.
  window.dispatchEvent(new CustomEvent("papr-workspace-reload"));
}
