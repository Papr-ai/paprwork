/**
 * Job health for every app in one request. Loads after the library paints,
 * refreshes when the window regains focus, and never blocks the grid.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppsHealthMap } from "../../src/core/utils/appsHealth";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

/** Focus bursts (alt-tab back and forth) shouldn't refetch more than this. */
const MIN_REFRESH_MS = 15_000;

export function useAppsHealth(): {
  health: AppsHealthMap;
  refresh: () => void;
} {
  const [health, setHealth] = useState<AppsHealthMap>({});
  const lastFetch = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - lastFetch.current < MIN_REFRESH_MS) return;
    lastFetch.current = Date.now();
    try {
      const res = await fetch(`${GATEWAY}/api/apps/health`);
      if (!res.ok) return;
      const body = (await res.json()) as { apps?: AppsHealthMap };
      if (body.apps) setHealth(body.apps);
    } catch {
      /* Health is decoration: an older gateway or offline gateway leaves cards as-is. */
    }
  }, []);

  useEffect(() => {
    void load(true);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return { health, refresh: useCallback(() => void load(true), [load]) };
}
