/**
 * SQLite-based persistence for tabs and favorites
 * Much faster than localStorage for large datasets
 */

import { useEffect, useCallback } from 'react';
import { useTabStore } from '../stores/tabStore';
import { gateway } from '../src/lib/gateway';
import { loadPersistedAppStateFromGateway } from '../lib/persistedAppState';

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

    try {
      localStorage.removeItem('paprwork-tab-storage');
    } catch {
      /* legacy global tab cache */
    }

    void loadPersistedAppStateFromGateway()
      .then(() => {
        console.log(
          `[Persistence] Loaded workspace tabs in ${(performance.now() - loadStartTime).toFixed(2)}ms`,
        );
      })
      .catch((error: Error) => {
        console.error('[Persistence] Failed to load tabs/state:', error);
      })
      .finally(() => {
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
