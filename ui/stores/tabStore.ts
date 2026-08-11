/**
 * Tab Store - Manages tab state with parent-child hierarchy
 *
 * Design: Tabs can be standalone or have parent-child relationships
 * - Standalone: Full screen, no children
 * - Parent: Has 1-2 children, shows split view
 * - Child: Belongs to parent, hidden from tab bar
 */

import { create } from "zustand";
import type { Tab, TabType, DisplayMode } from "../types/tabs";
import { gateway } from "../src/lib/gateway";

// Re-export for backward compatibility
export type { Tab, TabType, DisplayMode };

interface TabState {
  tabs: Tab[];
  activeTabId: string | null; // Active parent or standalone tab
  splitRatio: number; // DEPRECATED: Global split ratio (kept for backward compat)
  splitRatios: Record<string, number>; // Per-tab split ratios (tabId → ratio)

  // Navigation History
  history: string[]; // Array of tab IDs
  historyIndex: number; // Current position in history (-1 = no history)

  // Core Actions
  createTab: (
    type: TabType,
    entityId: string,
    title: string,
    metadata?: Record<string, unknown>,
  ) => string;
  switchToTab: (tabId: string, skipHistory?: boolean) => void;
  closeTab: (tabId: string) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  getTab: (tabId: string) => Tab | undefined;
  getVisibleTabs: () => Tab[];

  // Navigation History Actions
  goBack: () => boolean;
  goForward: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;

  // Parent-Child Actions
  addChild: (
    parentId: string,
    childId: string,
    position: "left" | "right",
    options?: { autoSwitch?: boolean },
  ) => void;
  removeChild: (parentId: string, childId: string) => void;
  replaceChild: (
    parentId: string,
    oldChildId: string,
    newChildId: string,
  ) => void;
  promoteToStandalone: (tabId: string) => void;
  createArtifactFromChat: (
    chatTabId: string,
    artifactTabId: string,
    options?: { autoSwitch?: boolean },
  ) => void;

  // Split View
  setSplitRatio: (ratio: number) => void;
  getSplitRatio: (tabId: string | null) => number;

  // Tab Status Indicators (for chat streaming)
  setTabStreaming: (tabId: string, isStreaming: boolean) => void;
  setTabUnread: (tabId: string, hasUnread: boolean) => void;
  setTabPendingRefresh: (tabId: string, pending: boolean) => void;
  markTabAsRead: (tabId: string) => void;
  updateTabId: (oldTabId: string, newTabId: string) => void;

  // Legacy compatibility (for backward compat during migration)
  enableSplitView: (leftTabId: string, rightTabId: string) => void;
  disableSplitView: () => void;
  isSplitView: boolean;
  activeLeftTab: string | null;
  activeRightTab: string | null;
}

export const useTabStore = create<TabState>()((set, get) => ({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5, // DEPRECATED: kept for backward compat
      splitRatios: {}, // Per-tab split ratios

      // Navigation History
      history: [],
      historyIndex: -1,

      // Legacy fields for backward compat
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,

      createTab: (type, entityId, title, metadata = {}) => {
        const tabId = `${type}-${entityId}`;

        // Special handling for chat tabs with temporary IDs
        // If creating a chat with temp ID, check for existing empty chats first
        if (
          type === "chat" &&
          entityId.startsWith("temp-") &&
          typeof window !== "undefined"
        ) {
          const state = get();

          // Check if any existing TEMP chat tab has no messages
          for (const tab of state.tabs) {
            if (tab.type === "chat" && tab.entityId.startsWith("temp-")) {
              // Get chat store from global window object (set by chatStore)
              const chatStore = (window as any).__chatStore__;
              if (chatStore && typeof chatStore.getChatState === "function") {
                const chatState = chatStore.getChatState(tab.entityId);
                if (
                  chatState &&
                  chatState.messages &&
                  chatState.messages.length === 0
                ) {
                  console.log(
                    `[TabStore] Found empty temp chat tab: ${tab.id}, reusing it`,
                  );
                  get().switchToTab(tab.id);
                  return tab.id;
                }
              }
            }
          }
          console.log(
            "[TabStore] No empty temp chat found, creating new chat tab",
          );
        }

        // Check if tab already exists
        const existingTab = get().tabs.find((t) => t.id === tabId);
        if (existingTab) {
          // Orphan child (hidden from tab bar) — promote so explicit opens get a visible tab
          if (existingTab.displayMode === "child" && !existingTab.parentTabId) {
            get().promoteToStandalone(tabId);
            get().switchToTab(tabId);
            return tabId;
          }
          // Merged child — switch to parent split view
          if (existingTab.parentTabId) {
            get().switchToTab(existingTab.parentTabId);
          } else {
            get().switchToTab(tabId);
          }
          return tabId;
        }

        const newTab: Tab = {
          id: tabId,
          type,
          entityId,
          title,
          icon: metadata.icon as string | undefined,
          parentTabId: null,
          childTabIds: [],
          displayMode: "standalone",
          metadata,
        };

        // Add tab and immediately set it as active in ONE state update
        console.log(`[TabStore.createTab] ========== START ==========`);
        console.log(`[TabStore.createTab] Creating tab: ${tabId}`);
        console.log(
          `[TabStore.createTab] Type: ${type}, EntityId: ${entityId}, Title: ${title}`,
        );

        set((state) => {
          const newTabs = [...state.tabs, newTab];
          console.log(
            `[TabStore.createTab] BEFORE set() - activeTabId: ${state.activeTabId}`,
          );
          console.log(
            `[TabStore.createTab] BEFORE set() - tabs count: ${state.tabs.length}`,
          );

          const newState = {
            tabs: newTabs,
            activeTabId: tabId,
            activeLeftTab: tabId,
            activeRightTab: null,
            isSplitView: false,
            // Add to history
            history: [...state.history, tabId],
            historyIndex: state.history.length,
          };

          console.log(
            `[TabStore.createTab] RETURNING new state - activeTabId: ${newState.activeTabId}`,
          );
          console.log(
            `[TabStore.createTab] RETURNING new state - tabs count: ${newState.tabs.length}`,
          );

          return newState;
        });

        // Immediately verify the state was updated
        const currentState = get();
        console.log(
          `[TabStore.createTab] AFTER set() - activeTabId: ${currentState.activeTabId}`,
        );
        console.log(
          `[TabStore.createTab] AFTER set() - tabs count: ${currentState.tabs.length}`,
        );
        console.log(
          `[TabStore.createTab] AFTER set() - tabs:`,
          currentState.tabs.map((t) => ({ id: t.id, entityId: t.entityId })),
        );
        console.log(`[TabStore.createTab] ========== END ==========`);

        return tabId;
      },

      switchToTab: (tabId, skipHistory = false) => {
        console.log(`[TabStore.switchToTab] Called with tabId: ${tabId}`);
        let tab = get().getTab(tabId);
        if (!tab) {
          console.error(`[TabStore.switchToTab] Tab not found: ${tabId}`);
          console.error(
            `[TabStore.switchToTab] Available tabs:`,
            get().tabs.map((t) => t.id),
          );
          return;
        }

        console.log(
          `[TabStore.switchToTab] Found tab, displayMode: ${tab.displayMode}`,
        );

        // Orphan child: full-screen content but hidden from tab bar — fix before switching
        if (tab.displayMode === "child" && !tab.parentTabId) {
          get().promoteToStandalone(tabId);
          tab = get().getTab(tabId)!;
        }

        // If switching to a child, switch to its parent instead
        if (tab.parentTabId) {
          const parent = get().getTab(tab.parentTabId);
          if (parent) {
            get().switchToTab(parent.id, skipHistory); // Recursively switch to parent
          }
          return;
        }

        const state = get();

        // Record in history (unless skipHistory is true or already on this tab)
        if (!skipHistory && tabId !== state.activeTabId) {
          const newHistory = state.history.slice(0, state.historyIndex + 1);
          newHistory.push(tabId);
          set({
            history: newHistory,
            historyIndex: newHistory.length - 1,
          });
        }

        // Mark tab as read when switching to it
        get().markTabAsRead(tabId);

        // Update legacy fields for backward compat
        const isParent =
          tab.displayMode === "parent" && tab.childTabIds.length > 0;

        console.log(`[TabStore.switchToTab] isParent: ${isParent}`);

        if (isParent) {
          // Parent tab with children - set up split view
          if (tab.childTabIds.length === 1) {
            // 1 child: Parent on left, child on right
            set({
              activeTabId: tabId,
              activeLeftTab: tabId, // Show parent in left pane
              activeRightTab: tab.childTabIds[0], // Show child in right pane
              isSplitView: true,
            });
          } else {
            // 2 children: First child on left, second child on right
            set({
              activeTabId: tabId,
              activeLeftTab: tab.childTabIds[0], // Show first child in left pane
              activeRightTab: tab.childTabIds[1], // Show second child in right pane
              isSplitView: true,
            });
          }
        } else {
          // Standalone tab - full screen
          console.log(
            `[TabStore.switchToTab] Setting standalone tab as active: ${tabId}`,
          );
          set({
            activeTabId: tabId,
            activeLeftTab: tabId,
            activeRightTab: null,
            isSplitView: false,
          });
          console.log(
            `[TabStore.switchToTab] Active tab is now: ${get().activeTabId}`,
          );
        }
      },

      closeTab: (tabId) => {
        const tab = get().getTab(tabId);
        if (!tab) return;

        // If closing a streaming chat tab, stop the stream first
        // This triggers the backend to save the partial response
        if (tab.type === "chat" && tab.metadata?.isStreaming) {
          gateway.send("agent:stop", { chatId: tab.entityId }).catch(() => {});
        }
        // Also check chatStore for streaming status (more reliable)
        if (tab.type === "chat") {
          try {
            const chatStore = (window as any).__chatStore__;
            if (chatStore?.getChatState) {
              const chatState = chatStore.getChatState(tab.entityId);
              if (chatState?.isSending) {
                gateway.send("agent:stop", { chatId: tab.entityId }).catch(() => {});
              }
            }
          } catch {}
        }

        const state = get();
        const visibleTabs = get().getVisibleTabs();
        const tabIndex = visibleTabs.findIndex((t) => t.id === tabId);

        // Collect all tab IDs to remove (parent + children)
        let idsToRemove = [tabId];
        if (tab.displayMode === "parent" && tab.childTabIds.length > 0) {
          idsToRemove = [tabId, ...tab.childTabIds];
        }

        // Remove tabs and update parent if child is being closed
        const newTabs = state.tabs
          .filter((t) => !idsToRemove.includes(t.id))
          .map((t) => {
            // If this is the parent of a child being closed, update childTabIds
            if (tab.parentTabId && t.id === tab.parentTabId) {
              const newChildIds = t.childTabIds.filter((id) => id !== tabId);
              return {
                ...t,
                childTabIds: newChildIds,
                displayMode:
                  newChildIds.length === 0
                    ? ("standalone" as DisplayMode)
                    : ("parent" as DisplayMode),
              };
            }
            return t;
          });

        const newVisibleTabs = newTabs.filter((t) => t.displayMode !== "child");

        // Clean up history - remove closed tabs from history
        const cleanedHistory = state.history.filter(
          (id) => !idsToRemove.includes(id),
        );
        const newHistoryIndex =
          state.historyIndex >= cleanedHistory.length
            ? cleanedHistory.length - 1
            : state.historyIndex;

        // Update active tab if needed
        let nextActiveId = state.activeTabId;
        if (idsToRemove.includes(state.activeTabId || "")) {
          const visibleTabs = state.tabs.filter(
            (t) => t.displayMode !== "child",
          );
          const tabIndex = visibleTabs.findIndex((t) => t.id === tabId);
          const nextTab =
            newVisibleTabs[Math.min(tabIndex, newVisibleTabs.length - 1)] ||
            newVisibleTabs[0];
          nextActiveId = nextTab?.id || null;
        }

        set({
          tabs: newTabs,
          activeTabId: nextActiveId,
          activeLeftTab: nextActiveId, // Legacy compat
          history: cleanedHistory,
          historyIndex: newHistoryIndex,
        });

        // Update legacy split view state
        if (nextActiveId) {
          get().switchToTab(nextActiveId, true); // Skip history recording on close
        }
      },

      moveTab: (fromIndex, toIndex) => {
        const state = get();
        const newTabs = [...state.tabs];
        const [movedTab] = newTabs.splice(fromIndex, 1);
        newTabs.splice(toIndex, 0, movedTab);
        set({ tabs: newTabs });
      },

      updateTabTitle: (tabId, title) => {
        const existingTab = get().tabs.find((t) => t.id === tabId);
        if (!existingTab) {
          console.error(`[TabStore] updateTabTitle: tab ${tabId} not found`);
          console.log(
            "[TabStore] Available tabs:",
            get().tabs.map((t) => t.id),
          );
          return;
        }
        console.log(`[TabStore] Updating tab ${tabId} title to: ${title}`);
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        }));
      },

      setSplitRatio: (ratio) => {
        const clampedRatio = Math.max(0.2, Math.min(0.8, ratio));
        const state = get();
        const activeTabId = state.activeTabId;
        
        if (activeTabId) {
          // Store ratio per tab
          set({ 
            splitRatio: clampedRatio, // Update global for backward compat
            splitRatios: {
              ...state.splitRatios,
              [activeTabId]: clampedRatio,
            },
          });
        } else {
          // Fallback to global if no active tab
          set({ splitRatio: clampedRatio });
        }
      },

      getSplitRatio: (tabId) => {
        const state = get();
        if (!tabId) return state.splitRatio;
        
        // Return tab-specific ratio if it exists, otherwise return global default
        return state.splitRatios[tabId] ?? state.splitRatio;
      },

      getTab: (tabId) => {
        return get().tabs.find((t) => t.id === tabId);
      },

      getVisibleTabs: () => {
        return get().tabs.filter((t) => t.displayMode !== "child");
      },

      addChild: (parentId, childId, position, options = {}) => {
        const { autoSwitch = true } = options;
        let parent = get().getTab(parentId);
        let child = get().getTab(childId);

        if (!parent || !child) {
          console.error("[TabStore] addChild: parent or child not found");
          return;
        }

        // Prevent self-parenting
        if (parentId === childId) {
          console.error("[TabStore] addChild: tab cannot be its own child");
          return;
        }

        // CRITICAL: If parent is currently a child, promote it to standalone first
        if (parent.parentTabId) {
          console.log(
            `[TabStore] Promoting parent ${parentId} from child to standalone before adding children`,
          );
          get().promoteToStandalone(parentId);
          // Refresh both references after promotion
          parent = get().getTab(parentId)!;
          child = get().getTab(childId)!;
        }

        // MAX 1 CHILD: If parent already has a child, replace it (max 2 panes total)
        let tabsToRemove: string[] = [];
        if (parent.childTabIds.length > 0) {
          // Never remove the tab we're about to add — it's already in the right place.
          // Removing + re-adding the same tab causes a render frame where the tab is
          // gone from `tabs` but still referenced by `childTabIds` → "Tab not found".
          const alreadyCorrectChild =
            parent.childTabIds.length === 1 &&
            parent.childTabIds[0] === childId;

          if (alreadyCorrectChild) {
            // Nothing to do — tab is already the child of this parent.
            if (autoSwitch) {
              get().switchToTab(parentId);
            } else {
              get().setTabPendingRefresh(parentId, true);
            }
            return;
          }

          console.log(
            `[TabStore] Replacing existing child ${parent.childTabIds[0]} with ${childId}`,
          );
          // Exclude childId itself from removal in case it's in the list
          tabsToRemove = parent.childTabIds.filter((id) => id !== childId);
        }

        set((state) => ({
          tabs: state.tabs
            .filter((t) => !tabsToRemove.includes(t.id)) // Remove old child/children
            .map((t) => {
              if (t.id === parentId) {
                return {
                  ...t,
                  displayMode: "parent" as DisplayMode,
                  childTabIds: [childId], // Always exactly 1 child
                };
              }
              if (t.id === childId) {
                return {
                  ...t,
                  parentTabId: parentId,
                  displayMode: "child" as DisplayMode,
                  position,
                };
              }
              return t;
            }),
        }));

        // Update legacy state
        if (autoSwitch) {
          get().switchToTab(parentId);
        } else {
          get().setTabPendingRefresh(parentId, true);
        }
      },

      removeChild: (parentId, childId) => {
        const parent = get().getTab(parentId);
        const child = get().getTab(childId);

        if (!parent || !child) return;

        set((state) => ({
          tabs: state.tabs.map((t) => {
            if (t.id === parentId) {
              const newChildIds = t.childTabIds.filter((id) => id !== childId);
              return {
                ...t,
                childTabIds: newChildIds,
                displayMode:
                  newChildIds.length === 0
                    ? ("standalone" as DisplayMode)
                    : ("parent" as DisplayMode),
              };
            }
            if (t.id === childId) {
              return {
                ...t,
                parentTabId: null,
                displayMode: "standalone" as DisplayMode,
                position: undefined,
              };
            }
            return t;
          }),
        }));

        // Update legacy state
        get().switchToTab(parentId);
      },

      replaceChild: (parentId, oldChildId, newChildId) => {
        const parent = get().getTab(parentId);
        const oldChild = get().getTab(oldChildId);
        const newChild = get().getTab(newChildId);

        if (!parent || !oldChild || !newChild) {
          console.error("[TabStore] replaceChild: tab not found");
          return;
        }

        const position = oldChild.position || "right";
        const index = parent.childTabIds.indexOf(oldChildId);

        if (index === -1) return;

        set((state) => ({
          tabs: state.tabs.map((t) => {
            if (t.id === parentId) {
              const newChildIds = [...t.childTabIds];
              newChildIds[index] = newChildId;
              return {
                ...t,
                childTabIds: newChildIds,
              };
            }
            if (t.id === oldChildId) {
              return {
                ...t,
                parentTabId: null,
                displayMode: "standalone" as DisplayMode,
                position: undefined,
              };
            }
            if (t.id === newChildId) {
              return {
                ...t,
                parentTabId: parentId,
                displayMode: "child" as DisplayMode,
                position,
              };
            }
            return t;
          }),
        }));

        // Update legacy state
        get().switchToTab(parentId);
      },

      promoteToStandalone: (tabId) => {
        const tab = get().getTab(tabId);
        if (!tab) return;

        const parentId = tab.parentTabId;

        // Remove from parent
        if (parentId) {
          get().removeChild(parentId, tabId);
        }

        set((state) => {
          const tabs = state.tabs.map((t) => {
            if (t.id === tabId) {
              return {
                ...t,
                parentTabId: null,
                displayMode: "standalone" as DisplayMode,
                position: undefined,
              };
            }
            return t;
          });

          // If the tab had a parent, move it to be adjacent to the parent
          if (parentId) {
            const currentIndex = tabs.findIndex((t) => t.id === tabId);
            const parentIndex = tabs.findIndex((t) => t.id === parentId);

            if (currentIndex !== -1 && parentIndex !== -1) {
              // Remove from current position
              const [movedTab] = tabs.splice(currentIndex, 1);
              // Insert right after parent
              const insertIndex =
                currentIndex < parentIndex ? parentIndex : parentIndex + 1;
              tabs.splice(insertIndex, 0, movedTab);
            }
          }

          return { tabs };
        });
      },

      createArtifactFromChat: (chatTabId, artifactTabId, options = {}) => {
        const { autoSwitch = true } = options;
        const chat = get().getTab(chatTabId);
        if (!chat) return;

        // Case 1: Chat is standalone → make it parent with artifact as child
        if (chat.displayMode === "standalone") {
          get().addChild(chatTabId, artifactTabId, "right", { autoSwitch });
          return;
        }

        // Case 2: Chat is parent → replace existing child with artifact
        if (chat.displayMode === "parent") {
          get().addChild(chatTabId, artifactTabId, "right", { autoSwitch }); // max-1-child auto-replaces
          return;
        }

        // Case 3: Chat is child → replace parent with artifact, keep chat in SAME position
        if (chat.displayMode === "child" && chat.parentTabId) {
          console.log(
            `[TabStore] Chat is child, replacing parent with artifact, keeping chat position`,
          );
          const oldParentId = chat.parentTabId;
          const chatPosition = chat.position!; // Chat's current visual position

          // Promote chat to standalone (breaks parent-child link)
          get().promoteToStandalone(chatTabId);

          // Remove the old parent (the OTHER pane)
          set((state) => ({
            tabs: state.tabs.filter((t) => t.id !== oldParentId),
          }));

          // Make artifact the new parent, with chat as child in SAME position
          get().addChild(artifactTabId, chatTabId, chatPosition, { autoSwitch });
          return;
        }

        // Fallback (shouldn't reach here)
        get().addChild(chatTabId, artifactTabId, "right", { autoSwitch });
      },

      // Legacy compatibility methods
      enableSplitView: (draggedTabId, targetTabId) => {
        // When dragging onto a tab:
        // - Target tab (what you drag onto) stays as parent
        // - Dragged tab becomes the child (replaces any existing child)
        get().addChild(targetTabId, draggedTabId, "right");
      },

      disableSplitView: () => {
        const activeTab = get().getTab(get().activeTabId || "");
        if (!activeTab) return;

        // Promote all children to standalone
        if (activeTab.displayMode === "parent") {
          activeTab.childTabIds.forEach((childId) => {
            get().promoteToStandalone(childId);
          });
        }
      },

      // Navigation History
      goBack: () => {
        const state = get();

        // Can't go back if we're at the beginning or no history
        if (state.history.length === 0 || state.historyIndex <= 0) {
          return false;
        }

        const newIndex = state.historyIndex - 1;
        const targetTabId = state.history[newIndex];

        // Check if tab still exists
        if (!get().getTab(targetTabId)) {
          // Tab was closed, remove from history and try previous
          const cleanedHistory = state.history.filter(
            (id) => id !== targetTabId,
          );
          set({
            history: cleanedHistory,
            historyIndex: Math.max(0, newIndex - 1),
          });

          // Only retry if we still have history to go back to
          if (cleanedHistory.length > 0 && get().historyIndex > 0) {
            return get().goBack();
          }
          return false;
        }

        set({ historyIndex: newIndex });
        get().switchToTab(targetTabId, true); // Skip history recording
        return true;
      },

      goForward: () => {
        const state = get();

        // Can't go forward if we're at the end or no history
        if (
          state.history.length === 0 ||
          state.historyIndex >= state.history.length - 1
        ) {
          return false;
        }

        const newIndex = state.historyIndex + 1;
        const targetTabId = state.history[newIndex];

        // Check if tab still exists
        if (!get().getTab(targetTabId)) {
          // Tab was closed, remove from history and try next
          const cleanedHistory = state.history.filter(
            (id) => id !== targetTabId,
          );
          set({
            history: cleanedHistory,
            historyIndex: Math.min(newIndex, cleanedHistory.length - 1),
          });

          // Only retry if we still have history to go forward to
          if (
            cleanedHistory.length > 0 &&
            get().historyIndex < cleanedHistory.length - 1
          ) {
            return get().goForward();
          }
          return false;
        }

        set({ historyIndex: newIndex });
        get().switchToTab(targetTabId, true); // Skip history recording
        return true;
      },

      canGoBack: () => {
        const state = get();
        return state.historyIndex > 0;
      },

      canGoForward: () => {
        const state = get();
        return state.historyIndex < state.history.length - 1;
      },

      // Update tab ID (for converting temp chat IDs to permanent ones)
      updateTabId: (oldTabId: string, newTabId: string) => {
        const state = get();
        const tab = state.tabs.find((t) => t.id === oldTabId);

        if (!tab) {
          console.warn(`[TabStore] updateTabId: tab ${oldTabId} not found`);
          return;
        }

        // Extract new entityId from newTabId (e.g., "chat-abc123" → "abc123")
        const newEntityId = newTabId.split("-").slice(1).join("-");

        set((state) => ({
          tabs: state.tabs.map((t) => {
            if (t.id === oldTabId) {
              return {
                ...t,
                id: newTabId,
                entityId: newEntityId,
              };
            }
            // Update references in parent/child relationships
            if (t.parentTabId === oldTabId) {
              return { ...t, parentTabId: newTabId };
            }
            if (t.childTabIds.includes(oldTabId)) {
              return {
                ...t,
                childTabIds: t.childTabIds.map((id) =>
                  id === oldTabId ? newTabId : id,
                ),
              };
            }
            return t;
          }),
          // Update activeTabId if it was the old ID
          activeTabId:
            state.activeTabId === oldTabId ? newTabId : state.activeTabId,
          activeLeftTab:
            state.activeLeftTab === oldTabId ? newTabId : state.activeLeftTab,
          activeRightTab:
            state.activeRightTab === oldTabId ? newTabId : state.activeRightTab,
          // Update history
          history: state.history.map((id) => (id === oldTabId ? newTabId : id)),
        }));

        console.log(`[TabStore] Updated tab ID: ${oldTabId} → ${newTabId}`);
      },

      // Tab Status Indicators (Paprwork V1 style)
      setTabStreaming: (tabId, isStreaming) => {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  isStreaming,
                  hasUnread: false,
                  ...(isStreaming ? { pendingRefresh: false } : {}),
                }
              : t,
          ),
        }));
      },

      setTabUnread: (tabId, hasUnread) => {
        const state = get();

        // Only set unread if tab is NOT active
        if (tabId === state.activeTabId) {
          return;
        }

        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  hasUnread,
                  isStreaming: false,
                  pendingRefresh: false,
                }
              : t,
          ),
        }));
      },

      setTabPendingRefresh: (tabId, pending) => {
        const state = get();

        // Only set pending if tab is NOT active
        if (tabId === state.activeTabId) {
          return;
        }

        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, pendingRefresh: pending } : t,
          ),
        }));
      },

      markTabAsRead: (tabId) => {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  hasUnread: false,
                  pendingRefresh: false,
                }
              : t,
          ),
        }));
      },
}));
