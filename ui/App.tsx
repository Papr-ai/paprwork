/**
 * App - Main application root
 * Paprwork v2 with Sidebar + TabBar + ContentArea layout
 */

import { useEffect, useState } from "react";
import { AppLayout } from "./components/Layout/AppLayout";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TabBar } from "./components/Tabs/TabBar";
import { ContentArea } from "./components/Layout/ContentArea";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { useChat } from "./hooks/useChat";
import { useTabs } from "./hooks/useTabs";
import { useTabStore } from "./stores/tabStore";
import {
  usePermissionStore,
  initPermissionListener,
} from "./stores/permissionStore";
import { initJobPermissionListener } from "./stores/jobPermissionStore";
import { initJobLiveLogsListener } from "./stores/jobLiveLogsStore";
import { initSubagentJobStore } from "./stores/subagentJobStore";
import { KeyPermissionModal } from "./components/Permissions/KeyPermissionModal";
import { UpdateBanner } from "./components/UpdateBanner/UpdateBanner";
import { useAppStatePersistence } from "./hooks/useAppStatePersistence";
import "./styles/liquid-glass.css";
import "./App.css";

export function App() {
  // Track React initialization timing
  const appStartTime = performance.now();
  console.log(`[React] App component mounting at ${appStartTime.toFixed(2)}ms`);

  // ALL HOOKS MUST COME BEFORE ANY CONDITIONAL RETURNS
  
  // Initialize SQLite persistence for tabs/favorites (fast!)
  useAppStatePersistence();

  // Load UI preferences from settings BEFORE first render
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [sqliteLoaded, setSqliteLoaded] = useState(false);
  
  useEffect(() => {
    const loadUIPreferences = async () => {
      try {
        const { gateway } = await import('./src/lib/gateway.js');
        
        // Always load from settings (source of truth)
        const response = await gateway.send('settings:get', {});
        
        if (response.success && response.data?.uiPreferences) {
          const { lastModelId } = response.data.uiPreferences;
          
          // Populate localStorage for fast access (model selection only)
          if (lastModelId) {
            localStorage.setItem("paprwork_last_model_id", lastModelId);
          }
          
          console.log('[App] UI preferences loaded from settings:', { lastModelId });
        } else {
          console.log('[App] No UI preferences found in settings, using defaults');
        }
        
        setPreferencesLoaded(true);
      } catch (error) {
        console.error('[App] Failed to load UI preferences:', error);
        setPreferencesLoaded(true); // Continue anyway
      }
    };
    
    loadUIPreferences();
  }, []);

  // Listen for SQLite load completion
  useEffect(() => {
    const handleSqliteLoaded = () => {
      console.log('[App] SQLite persistence loaded');
      setSqliteLoaded(true);
    };
    
    window.addEventListener('papr-sqlite-loaded', handleSqliteLoaded);
    
    // If already loaded (race condition), mark as loaded
    if ((window as any).__paprSqliteLoaded) {
      setSqliteLoaded(true);
    }
    
    return () => window.removeEventListener('papr-sqlite-loaded', handleSqliteLoaded);
  }, []);

  const { chats, createChat } = useChat();
  const { tabs, createTab } = useTabs();
  const { activeTabId, activeLeftTab } = useTabStore();
  const { activeRequest, claimedByChat, respond } = usePermissionStore();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  
  // Create getting-started tab on first run
  useEffect(() => {
    const checkOnboarding = () => {
      const dismissed = localStorage.getItem("papr-onboarding-dismissed") === "true";
      const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
      const step2 = localStorage.getItem("papr-onboarding-step2") === "true";
      const step3 = localStorage.getItem("papr-onboarding-step3") === "true";
      
      // Show getting started tab if not dismissed and no steps completed
      const shouldShow = !dismissed && !step1 && !step2 && !step3;
      
      if (shouldShow) {
        // Check if getting-started tab already exists
        const gettingStartedTab = tabs.find(t => t.type === 'getting-started');
        if (!gettingStartedTab) {
          console.log('[App] Creating getting-started tab');
          createTab('getting-started', 'default', 'Getting Started');
        }
      }
      // Do not auto-close Getting Started: users can reopen it from the sidebar
    };
    
    // Check on mount
    checkOnboarding();
    
    // Listen for onboarding state changes
    window.addEventListener('papr-onboarding-changed', checkOnboarding);
    return () => window.removeEventListener('papr-onboarding-changed', checkOnboarding);
  }, [tabs, createTab]);

  // Log when React finishes first render
  useEffect(() => {
    console.log(`[React] App component mounted at +${(performance.now() - appStartTime).toFixed(2)}ms`);
  }, [appStartTime]);

  // Cmd+K to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Initialize permission listeners
  useEffect(() => {
    initPermissionListener();
    initJobPermissionListener();
    initJobLiveLogsListener();
    initSubagentJobStore();
  }, []);

  // Don't render app until preferences AND SQLite are loaded
  if (!preferencesLoaded || !sqliteLoaded) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#fff' }}>
      Loading {!preferencesLoaded && 'preferences'}{!preferencesLoaded && !sqliteLoaded && ' and '}{!sqliteLoaded && 'app state'}...
    </div>;
  }

  const activeTab = tabs.find((t) => t.id === activeTabId);

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
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <UpdateBanner />
    </>
  );
}

export default App;
