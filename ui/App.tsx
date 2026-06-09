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
import { AuthWall } from "./components/Auth/AuthWall";
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
import { useChatStore } from "./stores/chatStore";
import {
  initializeAmplitudeBrowser,
  setTelemetryPaprUserId,
} from "./lib/telemetry";
import { gateway } from "./src/lib/gateway";
import "./styles/liquid-glass.css";
import "./App.css";

type ChatOpenPayload = {
  message?: string;
  model?: string | null;
  provider?: string | null;
};

// Check if Papr authentication is required (commercial build vs open source)
const REQUIRE_PAPR_AUTH = (import.meta as any).env?.VITE_REQUIRE_PAPR_AUTH === 'true';

export function App() {
  // Track React initialization timing
  // const appStartTime = performance.now();
  //console.log(`[React] App component mounting at ${appStartTime.toFixed(2)}ms`);

  // ALL HOOKS MUST COME BEFORE ANY CONDITIONAL RETURNS
  
  // Track authentication state (for commercial builds)
  // Check this FIRST before loading anything else
  const [isAuthenticated, setIsAuthenticated] = useState(!REQUIRE_PAPR_AUTH);
  const [authChecked, setAuthChecked] = useState(false);
  
  // Check authentication immediately (before loading preferences/SQLite)
  useEffect(() => {
    if (!REQUIRE_PAPR_AUTH) {
      setAuthChecked(true);
      return;
    }

    // Check if user is already authenticated
    const checkAuth = async () => {
      try {
        const result = await window.electronAPI.papr.checkLoginStatus();
        if (result.success && result.isLoggedIn) {
          setIsAuthenticated(true);
        }
      } catch (err) {
        console.error('[App] Failed to check authentication:', err);
      } finally {
        setAuthChecked(true);
      }
    };

    checkAuth();
  }, []);
  
  // Initialize SQLite persistence for tabs/favorites (fast!)
  useAppStatePersistence();

  // Load UI preferences from settings BEFORE first render
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [sqliteLoaded, setSqliteLoaded] = useState(false);
  
  useEffect(() => {
    const loadUIPreferences = async () => {
      try {
        const response = await gateway.send('settings:get', {}) as {
          success: boolean;
          data?: {
            uiPreferences?: {
              lastModelId?: string;
            };
          };
        };
        
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

  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();
  const { activeRequest, claimedByChat, respond } = usePermissionStore();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  
  // Create getting-started tab on first run
  useEffect(() => {
    // Add platform class to body for platform-specific CSS
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('mac')) {
      document.body.classList.add('platform-darwin');
    } else if (platform.includes('win')) {
      document.body.classList.add('platform-win32');
    } else {
      document.body.classList.add('platform-linux');
    }
    
    const checkOnboarding = () => {
      const dismissed = localStorage.getItem("papr-onboarding-dismissed") === "true";
      const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
      const step2 = localStorage.getItem("papr-onboarding-step2") === "true";
      
      // Show getting started tab if not dismissed and no steps completed
      const shouldShow = !dismissed && !step1 && !step2;
      
      if (shouldShow) {
        // Check if getting-started tab already exists (use getState to avoid dependency)
        const currentTabs = useTabStore.getState().tabs;
        const gettingStartedTab = currentTabs.find(t => t.type === 'getting-started');
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
  }, [createTab]); // Removed tabs dependency - use getState() instead

  // Initialize Amplitude telemetry (events only, no session replay)
  useEffect(() => {
    const initTelemetry = async () => {
      console.log('[Telemetry] Starting initialization...');
      
      try {
        // Get telemetry settings
        console.log('[Telemetry] Getting settings...');
        const telemetryResult = await window.electronAPI.telemetry.getEnabled();
        console.log('[Telemetry] Settings result:', telemetryResult);
        const telemetryEnabled = telemetryResult?.enabled ?? false;

        if (!telemetryEnabled) {
          console.log('[Telemetry] Disabled by user');
          return;
        }

        // Get install ID from settings
        console.log('[Telemetry] Getting install ID...');
        const settingsResponse = await gateway.send('settings:get', {}) as {
          success: boolean;
          data?: {
            telemetry?: {
              installId?: string;
            };
          };
        };
        console.log('[Telemetry] Settings response:', { hasData: !!settingsResponse.data, hasTelemetry: !!settingsResponse.data?.telemetry });
        const installId = settingsResponse.data?.telemetry?.installId;

        if (!installId) {
          console.warn('[Telemetry] No install ID found');
          return;
        }

        console.log('[Telemetry] Install ID:', installId.substring(0, 8) + '...');

        // Get app version
        const appVersion = await window.electronAPI.getAppVersion();
        console.log('[Telemetry] App version:', appVersion);

        // Check for Papr user ID (identified analytics for authenticated users)
        let paprUserId: string | undefined;
        try {
          const profileResult = await window.electronAPI.papr?.getProfile?.();
          if (profileResult?.profile?.userId) {
            paprUserId = profileResult.profile.userId;
            console.log('[Telemetry] Papr user:', paprUserId.substring(0, 8) + '...');
          }
        } catch {
          // No Papr profile — anonymous tracking only
        }

        // Initialize Amplitude (events only) - now static import
        console.log('[Telemetry] Calling initializeAmplitudeBrowser...');
        await initializeAmplitudeBrowser(installId, telemetryEnabled, appVersion, paprUserId);

        console.log('[Telemetry] ✅ Amplitude initialized with event tracking' + (paprUserId ? ' (identified)' : ' (anonymous)'));
      } catch (error) {
        console.error('[Telemetry] ❌ Failed to initialize:', error);
        console.error('[Telemetry] Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    };

    initTelemetry();
  }, []);

  // Re-identify telemetry when Papr login state changes mid-session
  useEffect(() => {
    const paprApi = window.electronAPI?.papr;
    if (!paprApi) {
      return;
    }

    const handleLoginSuccess = async (data?: {
      email?: string;
      name?: string;
      userId?: string;
    }) => {
      let userId = data?.userId;
      if (!userId) {
        try {
          const profileResult = await paprApi.getProfile();
          userId = profileResult?.profile?.userId;
        } catch {
          return;
        }
      }
      if (userId) {
        setTelemetryPaprUserId(userId);
      }
    };

    const handleLogoutSuccess = () => {
      setTelemetryPaprUserId(null);
    };

    paprApi.onLoginSuccess(handleLoginSuccess);
    paprApi.onLogoutSuccess(handleLogoutSuccess);

    const onAuthSuccess = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      void handleLoginSuccess(detail);
    };
    window.addEventListener("papr-auth-success", onAuthSuccess);
    window.addEventListener("papr-logout-success", handleLogoutSuccess);

    return () => {
      paprApi.removeLoginSuccessListener(handleLoginSuccess);
      paprApi.removeLogoutSuccessListener(handleLogoutSuccess);
      window.removeEventListener("papr-auth-success", onAuthSuccess);
      window.removeEventListener("papr-logout-success", handleLogoutSuccess);
    };
  }, []);

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

  // Mini-apps: window.paprAPI.invoke('chat.open', ...) → main → preload → papr-chat-open
  useEffect(() => {
    const handleChatOpen = (event: Event) => {
      const detail = (event as CustomEvent<ChatOpenPayload>).detail ?? {};
      console.log("[App] chat:open from mini-app:", detail);

      void (async () => {
        const chatId = await createChat();
        if (!chatId) return;
        const tabId = createTab("chat", chatId, "New Chat");
        const msg = detail.message?.trim();
        if (msg) {
          useChatStore.getState().setDraftMessage(chatId, msg);
        }
        const modelId = detail.model?.trim();
        if (modelId) {
          useChatStore.getState().setLastSelectedModel(chatId, modelId);
        }
        switchToTab(tabId);
      })();
    };

    window.addEventListener("papr-chat-open", handleChatOpen);
    return () => window.removeEventListener("papr-chat-open", handleChatOpen);
  }, [createChat, createTab, switchToTab]);

  // Show authentication wall IMMEDIATELY if required (before loading anything else)
  if (REQUIRE_PAPR_AUTH && !authChecked) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--background-color, #1a1a2e)' }} />;
  }

  if (REQUIRE_PAPR_AUTH && !isAuthenticated) {
    return <AuthWall onAuthenticated={() => setIsAuthenticated(true)} />;
  }

  // Don't render app until preferences AND SQLite are loaded
  if (!preferencesLoaded || !sqliteLoaded) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#fff' }}>
      Loading {!preferencesLoaded && 'preferences'}{!preferencesLoaded && !sqliteLoaded && ' and '}{!sqliteLoaded && 'app state'}...
    </div>;
  }

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
