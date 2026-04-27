/**
 * SQLite-based persistence for tabs and favorites
 * Much faster than localStorage for large datasets
 */

import { useEffect, useCallback } from 'react';
import { useTabStore } from '../stores/tabStore';
import { gateway } from '../src/lib/gateway';

export function useAppStatePersistence() {
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const splitRatio = useTabStore((state) => state.splitRatio);
  const splitRatios = useTabStore((state) => state.splitRatios);
  const history = useTabStore((state) => state.history);
  const historyIndex = useTabStore((state) => state.historyIndex);

  // Load tabs from SQLite on mount
  useEffect(() => {
    console.log('[Persistence] Loading tabs from SQLite...');
    const loadStartTime = performance.now();
    
    // Load tabs first
    gateway.send('app:load_tabs', {}).then((response: any) => {
      if (response.success && response.data && Array.isArray(response.data) && response.data.length > 0) {
        console.log(`[Persistence] Loaded ${response.data.length} tabs in ${(performance.now() - loadStartTime).toFixed(2)}ms`);
        
        // Convert from SQLite format to Tab format
        const restoredTabs = response.data.map((tab: any) => ({
          id: tab.id,
          type: tab.type,
          entityId: tab.entityId,
          title: tab.title,
          displayMode: tab.displayMode,
          parentTabId: tab.parentTabId,
          childTabIds: [], // Will be populated below
          isFavorite: tab.isFavorite,
          hasUnread: false,
          isStreaming: false,
        }));
        
        // Build parent-child relationships
        const tabMap = new Map(restoredTabs.map((t: any) => [t.id, t]));
        for (const tab of restoredTabs) {
          if (tab.parentTabId) {
            // Prevent self-referencing (data corruption guard)
            if (tab.parentTabId === tab.id) {
              console.warn(`[Persistence] Detected self-referencing tab: ${tab.id}, clearing parentTabId`);
              tab.parentTabId = null;
              continue;
            }
            
            const parent = tabMap.get(tab.parentTabId);
            if (parent && !parent.childTabIds.includes(tab.id)) {
              parent.childTabIds.push(tab.id);
            }
          }
        }
        
        console.log('[Persistence] Restored tab relationships:', 
          restoredTabs.map((t: any) => ({ 
            id: t.id, 
            title: t.title, 
            parentTabId: t.parentTabId, 
            childTabIds: t.childTabIds 
          }))
        );
        
        // Restore tabs to Zustand
        useTabStore.setState({
          tabs: restoredTabs,
        });
      } else {
        console.log('[Persistence] No tabs found in SQLite, starting fresh');
      }
      
      // ALWAYS load app state (even if no tabs)
      return gateway.send('app:load_state', {});
    }).then((response: any) => {
      console.log('[Persistence] app:load_state response:', {
        hasResponse: !!response,
        success: response?.success,
        hasData: !!response?.data,
        data: response?.data
      });
      
      if (response && response.success && response.data) {
        console.log('[Persistence] Loaded app state:', response.data);
        const state = response.data;
        
        // Restore ALL app state to Zustand store
        useTabStore.setState({
          activeTabId: state.activeTabId || null,
          splitRatio: state.splitRatio || 0.5,
          splitRatios: state.splitRatios || {},
          history: state.history || [],
          historyIndex: state.historyIndex ?? -1,
        });
        
        // Also restore onboarding state to localStorage for OnboardingCard
        const step1Value = state.onboardingStep1Completed ? 'true' : 'false';
        const step2Value = state.onboardingStep2Completed ? 'true' : 'false';
        const dismissedValue = state.onboardingDismissed ? 'true' : 'false';
        
        localStorage.setItem('papr-onboarding-step1', step1Value);
        localStorage.setItem('papr-onboarding-step2', step2Value);
        localStorage.setItem('papr-onboarding-dismissed', dismissedValue);
        
        // Switch to the restored active tab if it exists
        if (state.activeTabId) {
          const { switchToTab, getTab } = useTabStore.getState();
          const tab = getTab(state.activeTabId);
          if (tab) {
            console.log(`[Persistence] Switching to restored active tab: ${state.activeTabId}`);
            switchToTab(state.activeTabId, true); // Skip history recording
          }
        }
      } else {
        console.log('[Persistence] No app state found in SQLite, using defaults');
      }
      
      // ALWAYS notify that SQLite load is complete (even if no data)
      (window as any).__paprSqliteLoaded = true;
      window.dispatchEvent(new CustomEvent('papr-sqlite-loaded'));
    }).catch((error: Error) => {
      console.error('[Persistence] Failed to load tabs/state:', error);
      // Mark as loaded even on error so app doesn't hang
      (window as any).__paprSqliteLoaded = true;
      window.dispatchEvent(new CustomEvent('papr-sqlite-loaded'));
    });
  }, []); // Only run once on mount

  // Save tabs to SQLite (debounced)
  useEffect(() => {
    if (tabs.length === 0) return;

    const saveTimeout = setTimeout(() => {
      console.log('[Persistence] Saving tabs to SQLite...');
      const saveStartTime = performance.now();
      
      // Convert tabs to SQLite format
      const tabsToSave = tabs.map((tab, index) => ({
        id: tab.id,
        type: tab.type,
        entityId: tab.entityId,
        title: tab.title,
        displayMode: tab.displayMode,
        parentTabId: tab.parentTabId,
        position: index,
        isFavorite: tab.isFavorite || false,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      }));

      gateway.send('app:save_tabs', tabsToSave).then(() => {
        console.log(`[Persistence] Saved ${tabs.length} tabs in ${(performance.now() - saveStartTime).toFixed(2)}ms`);
      }).catch((error: Error) => {
        console.error('[Persistence] Failed to save tabs:', error);
      });
    }, 2000); // Increased debounce to 2 seconds to reduce save frequency

    return () => clearTimeout(saveTimeout);
  }, [tabs]);

  // Save app state (debounced) - includes split ratios, navigation history, and onboarding
  useEffect(() => {
    const saveTimeout = setTimeout(() => {
      // Read onboarding state from localStorage
      const onboardingStep1 = localStorage.getItem('papr-onboarding-step1') === 'true';
      const onboardingStep2 = localStorage.getItem('papr-onboarding-step2') === 'true';
      const onboardingDismissed = localStorage.getItem('papr-onboarding-dismissed') === 'true';
      
      gateway.send('app:save_state', {
        activeTabId,
        splitRatio,
        splitRatios,
        history,
        historyIndex,
        onboardingStep1Completed: onboardingStep1,
        onboardingStep2Completed: onboardingStep2,
        onboardingStep3Completed: false,
        onboardingDismissed,
        lastSavedAt: new Date().toISOString(),
      }).catch((error: Error) => {
        console.error('[Persistence] Failed to save app state:', error);
      });
    }, 1000); // Increased debounce to 1 second to reduce save frequency

    return () => clearTimeout(saveTimeout);
  }, [activeTabId, splitRatio, splitRatios, history, historyIndex]);

  // Listen for onboarding state changes and save to SQLite
  useEffect(() => {
    const handleOnboardingChange = () => {
      console.log('[Persistence] Onboarding state changed, saving to SQLite...');
      
      // Read all onboarding state and save to SQLite
      const onboardingStep1 = localStorage.getItem('papr-onboarding-step1') === 'true';
      const onboardingStep2 = localStorage.getItem('papr-onboarding-step2') === 'true';
      const onboardingDismissed = localStorage.getItem('papr-onboarding-dismissed') === 'true';
      
      gateway.send('app:save_state', {
        activeTabId: useTabStore.getState().activeTabId,
        splitRatio: useTabStore.getState().splitRatio,
        splitRatios: useTabStore.getState().splitRatios,
        history: useTabStore.getState().history,
        historyIndex: useTabStore.getState().historyIndex,
        onboardingStep1Completed: onboardingStep1,
        onboardingStep2Completed: onboardingStep2,
        onboardingStep3Completed: false,
        onboardingDismissed,
        lastSavedAt: new Date().toISOString(),
      }).catch((error: Error) => {
        console.error('[Persistence] Failed to save onboarding state:', error);
      });
    };

    window.addEventListener('papr-onboarding-changed', handleOnboardingChange);
    return () => window.removeEventListener('papr-onboarding-changed', handleOnboardingChange);
  }, []);

  // Toggle favorite
  const toggleFavorite = useCallback((tabId: string) => {
    gateway.send('app:toggle_favorite_tab', { tabId }).catch((error: Error) => {
      console.error('[Persistence] Failed to toggle favorite:', error);
    });
  }, []);

  return {
    toggleFavorite,
  };
}
