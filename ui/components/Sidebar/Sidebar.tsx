/**
 * Sidebar — the left rail. 96px, icon-first, clears the macOS traffic lights.
 * Your agent sits on top and is Focus (Home) — its peek shows your three goals; Chats / Apps / Docs show Pinned + Recent in hover peeks
 * (replacing the always-on Favorites list); account, settings and personalization live on the avatar.
 * Every destination and action from the previous 240px sidebar is still here.
 */

import { useMemo, useCallback, useEffect, useState } from "react";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import type { TabType } from "../../types/tabs";
import { FocusPeek, openFocusGoal } from "./FocusPeek";
import { OnboardingCard } from "./OnboardingCard";
import { ProfileFooter } from "./ProfileFooter";
import { RailItem } from "./RailItem";
import { RailPeek } from "./RailPeek";
import { RailIcons } from "./railIcons";
import { useSidebarFavorites } from "./useSidebarFavorites";
import { useRailPeeks } from "./useRailPeeks";
import { AgentGlyph } from "../Agent/AgentGlyph";
import { useAgentIdentity, useAgentName } from "../Agent/agentIdentityStore";
import { useAgentWork } from "../Agent/agentWork";
import { shouldShowOnboarding } from "../../utils/onboardingState";
import { switchToChatTab, switchToHomeTab } from "../../lib/ensureDefaultChatTab";
import "./Sidebar.css";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SEARCH_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";

type View = "chat" | "apps" | "memory" | "documents";

/** Map tab types to sidebar nav views */
function tabTypeToView(type: TabType | undefined): View {
  switch (type) {
    case "app":
    case "apps":
      return "apps";
    case "memory":
    case "home":
      return "memory";
    case "document":
    case "documents":
      return "documents";
    case "chat":
    default:
      return "chat";
  }
}

export function Sidebar() {
  const { createChat } = useChat();
  const { tabs, createTab, switchToTab, activeLeftTab } = useTabs();

  // Derive active view from the current left-pane tab type
  // For split view, activeLeftTab is the parent/left pane
  const activeView = useMemo<View>(() => {
    if (!activeLeftTab) return "memory";
    const tab = tabs.find((t) => t.id === activeLeftTab);
    if (!tab) return "chat";

    // For parent tabs (split view), use the parent's own type
    // If parent type is generic (e.g. "chat"), that's correct
    // If it's a document/app parent, it maps to "documents"
    return tabTypeToView(tab.type);
  }, [activeLeftTab, tabs]);

  const handleOpenSettings = useCallback(() => {
    const settingsId = createTab("settings", "settings", "Settings");
    switchToTab(settingsId);
  }, [createTab, switchToTab]);

  const handleOpenProfile = useCallback(() => {
    const settingsId = createTab("settings", "settings", "Settings");
    switchToTab(settingsId);
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("papr:open-settings", { detail: { tab: "profile" } }),
      );
    }, 60);
  }, [createTab, switchToTab]);

  const handleOpenGettingStarted = useCallback(() => {
    const tabId = createTab("getting-started", "default", "Getting Started");
    switchToTab(tabId);
  }, [createTab, switchToTab]);

  const handleNewChat = useCallback(async () => {
    const chatId = await createChat();
    if (chatId) {
      // Explicit click: always open a fresh standalone chat. Folding into an
      // existing blank chat looked like a dead button whenever that chat was
      // already on screen (e.g. merged with an app in split view).
      const tabId = createTab("chat", chatId, "New Chat", {}, { forceNew: true });
      switchToTab(tabId);
    }
  }, [createChat, createTab, switchToTab]);

  const handleOnboardingSendMessage = useCallback(
    async (message: string) => {
      // Create a new chat, switch to it, then dispatch event for ChatContainer to send
      const chatId = await createChat();
      if (chatId) {
        const tabId = createTab("chat", chatId, "New Chat");
        switchToTab(tabId);
        // Give the ChatContainer a moment to mount, then dispatch send event
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("papr-onboarding-send", { detail: { message } }),
          );
        }, 300);
      }
    },
    [createChat, createTab, switchToTab],
  );

  const handleNavClick = (view: View) => {
    let tabId: string | undefined;
    if (view === "apps") {
      tabId = createTab("apps" as TabType, "apps", "Apps");
    } else if (view === "memory") {
      tabId = switchToHomeTab();
      return;
    } else if (view === "documents") {
      tabId = createTab("documents" as TabType, "documents", "Documents");
    } else if (view === "chat") {
      switchToChatTab();
      return;
    }

    if (tabId) {
      switchToTab(tabId);
    }
  };

  useEffect(() => {
    const openCommunity = () => {
      const tabId = createTab("apps" as TabType, "apps", "Apps");
      switchToTab(tabId);
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-apps-view-tab", { detail: { tab: "community" } }),
        );
      }, 100);
    };
    window.addEventListener("papr-open-community-apps", openCommunity);
    return () => window.removeEventListener("papr-open-community-apps", openCommunity);
  }, [createTab, switchToTab]);

  const favoritesApi = useSidebarFavorites();
  const { chatGroups, appGroups, docGroups, hasUnreadChats } = useRailPeeks(favoritesApi);
  const agentName = useAgentName();
  const agentLook = useAgentIdentity((s) => s.look);
  const work = useAgentWork();
  const workingLabel = `${agentName} is working · ${work.count} ${work.count === 1 ? "chat" : "chats"}`;
  const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);

  useEffect(() => {
    const sync = () => setShowOnboarding(shouldShowOnboarding());
    window.addEventListener("papr-onboarding-changed", sync);
    return () => window.removeEventListener("papr-onboarding-changed", sync);
  }, []);

  const openSearch = () => window.dispatchEvent(new CustomEvent("papr-open-command-palette"));
  const openChatHistory = () => {
    switchToChatTab();
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("papr-open-chat-history")), 60);
  };

  return (
    <nav
      className={`sidebar rail${favoritesApi.isDragOver ? " rail--drag-over" : ""}`}
      aria-label="Main"
      {...favoritesApi.dropHandlers}
    >
      <div className="rail__drag" aria-hidden="true" />

      <RailItem
        variant="agent"
        label={work.state === "working" ? workingLabel : `Focus · ${agentName}`}
        ariaLabel={work.state === "working" ? `Focus · ${workingLabel}` : "Focus"}
        busy={work.state === "working"}
        active={activeView === "memory"}
        onClick={() => handleNavClick("memory")}
        icon={<AgentGlyph size={agentLook === "papr" ? 28 : 36} state={work.state} />}
        peek={
          <FocusPeek
            status={work.state === "working" ? workingLabel : <>{agentName}&apos;s picks</>}
            onOpen={(goalId) => {
              handleNavClick("memory");
              if (goalId) openFocusGoal(goalId);
            }}
          />
        }
      />
      <RailItem
        variant="new"
        label="New chat"
        onClick={handleNewChat}
        testId="new-chat-button"
        icon={
          <span className="rail-btn__new-orb">
            <RailIcons.plus />
          </span>
        }
      />
      <RailItem label="Search" shortcut={SEARCH_SHORTCUT} onClick={openSearch} icon={<RailIcons.search />} />

      <span className="rail__sep" aria-hidden="true" />

      <RailItem
        label="Chats"
        active={activeView === "chat"}
        onClick={() => handleNavClick("chat")}
        icon={<RailIcons.chats />}
        badge={hasUnreadChats}
        peek={
          <RailPeek
            title="Chats"
            groups={chatGroups}
            empty="No chats yet. Start one with +."
            footer={{ label: "All chats", onClick: openChatHistory }}
          />
        }
      />
      <RailItem
        label="Apps"
        active={activeView === "apps"}
        onClick={() => handleNavClick("apps")}
        icon={<RailIcons.apps />}
        peek={
          <RailPeek
            title="Apps"
            groups={appGroups}
            empty="Drag an app here to pin it."
            footer={{ label: "See all apps", onClick: () => handleNavClick("apps") }}
          />
        }
      />
      <RailItem
        label="Docs"
        ariaLabel="Documents"
        active={activeView === "documents"}
        onClick={() => handleNavClick("documents")}
        icon={<RailIcons.docs />}
        peek={
          <RailPeek
            title="Docs"
            groups={docGroups}
            empty="Drag a doc here to pin it."
            footer={{ label: "See all docs", onClick: () => handleNavClick("documents") }}
          />
        }
      />

      <span className="rail__grow" />

      <RailItem
        label="Getting started"
        onClick={handleOpenGettingStarted}
        icon={<RailIcons.start />}
        badge={showOnboarding}
        peekFromBottom
        peek={
          showOnboarding ? (
            <OnboardingCard
              onOpenGettingStarted={handleOpenGettingStarted}
              onSendMessage={handleOnboardingSendMessage}
            />
          ) : undefined
        }
      />
      <ProfileFooter onOpenProfile={handleOpenProfile} onOpenSettings={handleOpenSettings} />
    </nav>
  );
}
