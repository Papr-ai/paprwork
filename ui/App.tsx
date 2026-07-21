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
import { ensureGatewayRecoveryRegistered } from "./lib/agentStreamRecovery";
import { AppAgentChatOverlay } from "./components/Apps/AppAgentChatOverlay";
import type { AppAgentChatConfig } from "../src/core/types/appAgentChat";
import "./styles/liquid-glass.css";
import "./App.css";
import { shouldShowOnboarding } from "./utils/onboardingState";

type ChatOpenPayload = {
  message?: string;
  model?: string | null;
  provider?: string | null;
  mode?: "main" | "app-agent";
  appId?: string;
  subAgentId?: string;
};

type AppAgentChatSession = {
  appId: string;
  appTitle: string;
  config: AppAgentChatConfig;
  subAgentName: string;
  subAgentIcon?: string;
  initialMessage?: string;
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
  const [appAgentChatSession, setAppAgentChatSession] =
    useState<AppAgentChatSession | null>(null);
  
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

  useEffect(() => {
    ensureGatewayRecoveryRegistered();
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("paprwork-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("paprwork-sidebar-collapsed", String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };
  
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
      if (!shouldShowOnboarding()) return;

      const { tabs: currentTabs, createTab: openTab, switchToTab: activateTab } =
        useTabStore.getState();
      const existingTab = currentTabs.find((t) => t.type === "getting-started");
      if (!existingTab) {
        const tabId = openTab("getting-started", "getting-started", "Getting Started");
        activateTab(tabId);
      }
    };

    checkOnboarding();

    // Listen for changes from OnboardingView/OnboardingCard
    window.addEventListener("papr-onboarding-changed", checkOnboarding);
    return () =>
      window.removeEventListener("papr-onboarding-changed", checkOnboarding);
  }, []);

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
        const isAppAgent =
          detail.mode === "app-agent" ||
          (Boolean(detail.subAgentId) && Boolean(detail.appId));

        if (isAppAgent && detail.appId && detail.subAgentId) {
          try {
            const appResp = await gateway.send("app:get", { appId: detail.appId });
            const appData = appResp.data as {
              title?: string;
              agentChat?: AppAgentChatConfig;
            };
            const config =
              appData.agentChat ??
              ({
                enabled: true,
                subAgentId: detail.subAgentId,
              } satisfies AppAgentChatConfig);

            const agentResp = await gateway.send("subagent:get", {
              agentId: detail.subAgentId,
            });
            const agent = agentResp.data as {
              name?: string;
              icon?: string;
            };

            setAppAgentChatSession({
              appId: detail.appId,
              appTitle: appData.title?.trim() || "Mini-app",
              config,
              subAgentName: agent.name ?? detail.subAgentId,
              subAgentIcon: agent.icon,
              initialMessage: detail.message?.trim(),
            });
          } catch (err) {
            console.error("[App] Failed to open app agent chat:", err);
          }
          return;
        }

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
        sidebar={<Sidebar onToggleCollapse={toggleSidebarCollapsed} />}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebarCollapsed}
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
      {appAgentChatSession && (
        <AppAgentChatOverlay
          appId={appAgentChatSession.appId}
          appTitle={appAgentChatSession.appTitle}
          config={appAgentChatSession.config}
          subAgentName={appAgentChatSession.subAgentName}
          subAgentIcon={appAgentChatSession.subAgentIcon}
          initialMessage={appAgentChatSession.initialMessage}
          onClose={() => setAppAgentChatSession(null)}
        />
      )}
    </>
  );
}

export default App;
