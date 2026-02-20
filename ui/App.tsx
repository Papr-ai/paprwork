/**
 * App - Main application root
 * Paprwork v2 with Sidebar + TabBar + ContentArea layout
 */

import { useEffect, useState } from "react";
import { AppLayout } from "./components/Layout/AppLayout";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TabBar } from "./components/Tabs/TabBar";
import { ContentArea } from "./components/Layout/ContentArea";
import { useChat } from "./hooks/useChat";
import { useTabs } from "./hooks/useTabs";
import { useTabStore } from "./stores/tabStore";
import {
  usePermissionStore,
  initPermissionListener,
} from "./stores/permissionStore";
import { initJobPermissionListener } from "./stores/jobPermissionStore";
import { initJobLiveLogsListener } from "./stores/jobLiveLogsStore";
import { KeyPermissionModal } from "./components/Permissions/KeyPermissionModal";
import "./styles/liquid-glass.css";
import "./App.css";

export function App() {
  const { chats, createChat } = useChat();
  const { tabs, createTab } = useTabs();
  const { activeTabId, activeLeftTab } = useTabStore();
  const { activeRequest, claimedByChat, respond } = usePermissionStore();
  const [hydrated, setHydrated] = useState(false);

  // Initialize the Electron IPC permission listener once
  useEffect(() => {
    initPermissionListener();
  }, []);

  // Initialize job permission broadcast listener (Gateway WebSocket)
  useEffect(() => {
    initJobPermissionListener();
  }, []);

  // Initialize job live logs listener for streaming log display
  useEffect(() => {
    initJobLiveLogsListener();
  }, []);

  // Wait for Zustand persist to finish loading from localStorage
  useEffect(() => {
    const unsubscribe = useTabStore.persist.onFinishHydration(() => {
      console.log("[App] ✅ Tab store hydrated from localStorage");
      setHydrated(true);
    });

    // If already hydrated (e.g., hot reload), set immediately
    if (useTabStore.persist.hasHydrated()) {
      console.log("[App] ✅ Tab store already hydrated");
      setHydrated(true);
    }

    return unsubscribe;
  }, []);

  // Initialize a default chat and tab on mount (V1 approach)
  // Only runs AFTER hydration completes
  useEffect(() => {
    if (!hydrated) {
      console.log("[App.useEffect] ⏳ Waiting for hydration...");
      return;
    }
    console.log("[App.useEffect] ========== START ==========");

    const initialize = async () => {
      console.log(`[App.useEffect] Checking if initialization needed...`);
      console.log(`[App.useEffect] Current tabs.length: ${tabs.length}`);
      console.log(`[App.useEffect] Current activeTabId: ${activeTabId}`);

      // If no tabs exist, create a new temp chat with a tab
      if (tabs.length === 0) {
        console.log("[App.useEffect] ✅ No tabs found, creating initial tab");

        try {
          console.log("[App.useEffect] Step 1: Calling createChat()...");
          const tempChatId = await createChat(); // Creates temp chat
          console.log(
            `[App.useEffect] Step 1 DONE: tempChatId = ${tempChatId}`,
          );

          if (tempChatId) {
            console.log("[App.useEffect] Step 2: Calling createTab()...");
            const tabId = createTab("chat", tempChatId, "New Chat");
            console.log(`[App.useEffect] Step 2 DONE: tabId = ${tabId}`);

            // Verify it was set
            console.log("[App.useEffect] Step 3: Verifying state...");
            const currentState = useTabStore.getState();
            console.log(
              `[App.useEffect] Step 3: activeTabId = ${currentState.activeTabId}`,
            );
            console.log(
              `[App.useEffect] Step 3: tabs count = ${currentState.tabs.length}`,
            );

            if (!currentState.activeTabId) {
              console.error(
                "[App.useEffect] ❌ ERROR: activeTabId is STILL null/undefined after createTab!",
              );
              console.error("[App.useEffect] Full state:", currentState);
            } else {
              console.log(
                "[App.useEffect] ✅ SUCCESS: Tab created and activated!",
              );
            }
          } else {
            console.error(
              "[App.useEffect] ❌ ERROR: createChat() returned null/undefined",
            );
          }
        } catch (error) {
          console.error(
            "[App.useEffect] ❌ ERROR during initialization:",
            error,
          );
        }
      } else {
        console.log(`[App.useEffect] ⏭️  Tabs already exist (${tabs.length})`);
        console.log(`[App.useEffect] Current activeTabId:`, activeTabId);

        // If tabs exist but no active tab, restore from history or select first tab
        if (tabs.length > 0 && (!activeTabId || !activeLeftTab)) {
          console.log(
            "[App.useEffect] ⚠️  Missing active tab/pane selection despite existing tabs, restoring...",
          );
          const { history, historyIndex, switchToTab } = useTabStore.getState();

          console.log(`[App.useEffect] Tab history:`, {
            historyLength: history.length,
            historyIndex,
            history,
          });

          // First preference: restore persisted activeTabId when available.
          if (activeTabId) {
            console.log(
              `[App.useEffect] Restoring from activeTabId: ${activeTabId}`,
            );
            switchToTab(activeTabId, true);
          }
          // Otherwise restore from history.
          else if (history.length > 0 && historyIndex >= 0) {
            const lastActiveTabId = history[historyIndex];
            console.log(
              `[App.useEffect] Restoring from history: ${lastActiveTabId}`,
            );
            switchToTab(lastActiveTabId, true); // Skip adding to history
          } else {
            // Fallback to first tab
            console.log(
              `[App.useEffect] No history, selecting first tab: ${tabs[0].id}`,
            );
            switchToTab(tabs[0].id, true);
          }
        } else if (activeTabId) {
          console.log(
            `[App.useEffect] ✅ Active tab already persisted from localStorage: ${activeTabId}`,
          );
        }
      }

      console.log("[App.useEffect] ========== END ==========");
    };

    initialize();
  }, [hydrated, tabs.length, activeTabId, activeLeftTab]); // Re-run after hydration or tab selection changes

  return (
    <>
      <AppLayout
        sidebar={<Sidebar />}
        topBar={<TabBar />}
        content={<ContentArea />}
      />
      {activeRequest && !claimedByChat && (
        <KeyPermissionModal request={activeRequest} onResponse={respond} />
      )}
    </>
  );
}

export default App;
