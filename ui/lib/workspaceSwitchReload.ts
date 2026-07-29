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
import { ensureDefaultChatTab } from "./ensureDefaultChatTab";

const LEGACY_TAB_STORAGE_KEY = "paprwork-tab-storage";

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
  clearLegacyGlobalTabCache();
  clearCloudPublishCache();

  useArtifactsStore.getState().resetForWorkspaceSwitch();

  resetChatListCache();
  useChatStore.getState().resetForWorkspaceSwitch();

  window.dispatchEvent(new CustomEvent("papr-workspace-reload"));

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

  try {
    await loadPersistedAppStateFromGateway({ validChatIds });
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
}
