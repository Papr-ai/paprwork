/**
 * useApp Hook - Mini-app file watching and reload management
 *
 * Watches for app file changes and triggers iframe reload with debouncing
 * Similar to useDocument's file watching pattern
 */

import { useState, useCallback, useEffect, useRef } from "react";

export function useApp(appId: string | null) {
  const [reloadKey, setReloadKey] = useState(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trigger reload with debouncing (prevents multiple rapid reloads)
  const triggerReload = useCallback(() => {
    if (reloadTimer.current) {
      clearTimeout(reloadTimer.current);
    }

    // Debounce reload by 500ms (in case multiple files change)
    reloadTimer.current = setTimeout(() => {
      setReloadKey((prev) => prev + 1);
      console.log(`[useApp] Reloading app: ${appId}`);
    }, 500);
  }, [appId]);

  // Watch for app file changes
  useEffect(() => {
    if (!appId) return;

    // Listen for gateway broadcast events
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const data = customEvent.detail;

      if (data.type === "app:file-changed" && data.data?.appId === appId) {
        console.log(`[useApp] File changed detected for app: ${appId}`);
        triggerReload();
      }
    };

    window.addEventListener("gateway-broadcast", handler);

    return () => {
      window.removeEventListener("gateway-broadcast", handler);
      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
      }
    };
  }, [appId, triggerReload]);

  return {
    reloadKey, // Use as key on iframe to force reload
  };
}
