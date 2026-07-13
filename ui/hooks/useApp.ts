/**
 * useApp Hook - Mini-app file watching and reload management
 *
 * Watches for app file changes and triggers iframe reload with debouncing
 * Similar to useDocument's file watching pattern
 */

import { useState, useCallback, useEffect, useRef } from "react";

/** Wait for multi-file edit bursts to settle before reloading. */
const RELOAD_DEBOUNCE_MS = 2000;
/**
 * Minimum gap between iframe remounts. Large bundled apps (~1MB) need time to
 * download, parse, and run init() + DB fetches; rapid remounts abort JS before
 * data renders (static HTML/CSS shell with empty #content).
 */
const MIN_RELOAD_INTERVAL_MS = 3500;

export function useApp(appId: string | null) {
  const [reloadKey, setReloadKey] = useState(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReloadAt = useRef(0);

  const runReload = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastReloadAt.current;

    const commitReload = () => {
      lastReloadAt.current = Date.now();
      setReloadKey((prev) => prev + 1);
      console.log(`[useApp] Reloading app: ${appId}`);
    };

    if (elapsed < MIN_RELOAD_INTERVAL_MS) {
      const delay = MIN_RELOAD_INTERVAL_MS - elapsed;
      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
      }
      reloadTimer.current = setTimeout(commitReload, delay);
      console.log(
        `[useApp] Queued reload for ${appId} in ${delay}ms (min interval)`,
      );
      return;
    }

    commitReload();
  }, [appId]);

  // Trigger reload with debouncing (prevents multiple rapid reloads)
  const triggerReload = useCallback(() => {
    if (reloadTimer.current) {
      clearTimeout(reloadTimer.current);
    }

    reloadTimer.current = setTimeout(runReload, RELOAD_DEBOUNCE_MS);
  }, [runReload]);

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
    triggerReload,
  };
}
