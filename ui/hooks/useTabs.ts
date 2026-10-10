/**
 * useTabs Hook - React hook for tab management with parent-child hierarchy
 */

import { useTabStore } from "../stores/tabStore";

export function useTabs() {
  const {
    tabs,
    activeTabId,
    activeLeftTab,
    activeRightTab,
    isSplitView,
    splitRatio,
    history,
    historyIndex,
    createTab,
    switchToTab,
    closeTab,
    moveTab,
    updateTabTitle,
    getTab,
    getVisibleTabs,
    addChild,
    removeChild,
    replaceChild,
    promoteToStandalone,
    createArtifactFromChat,
    setSplitRatio,
    getSplitRatio,
    enableSplitView,
    disableSplitView,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  } = useTabStore();

  return {
    // State
    tabs,
    activeTabId,
    activeLeftTab,
    activeRightTab,
    isSplitView,
    splitRatio,
    history,
    historyIndex,

    // Core actions
    createTab,
    switchToTab,
    closeTab,
    moveTab,
    updateTabTitle,
    getTab,
    getVisibleTabs,

    // Parent-child actions
    addChild,
    removeChild,
    replaceChild,
    promoteToStandalone,
    createArtifactFromChat,

    // Split view
    setSplitRatio,
    getSplitRatio,
    enableSplitView,
    disableSplitView,

    // Navigation history
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  };
}
