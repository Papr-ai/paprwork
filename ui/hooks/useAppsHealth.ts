/**
 * Job health for every app in one request. Loads after the library paints,
 * refreshes when the window regains focus, and never blocks the grid.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppsHealthMap } from "../../src/core/utils/appsHealth";

/** Sharing prefs per app, straight from the file the Share sheet writes. */
export interface AppSharingPrefs {
  loginAccess?: "private" | "team" | "public" | "none";
  externalLink?: "off" | "read" | "read_write";
  codeAccess?: "off" | "install";
  requireSignIn?: boolean;
  allowedUserIds?: string[];
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
}
export type AppsSharingMap = Record<string, AppSharingPrefs>;

/** Fired when any app's sharing/publish state changes (Share sheet, publish). */
export const PUBLISH_STATE_CHANGED_EVENT = "papr-publish-state-changed";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

/** Focus bursts (alt-tab back and forth) shouldn't refetch more than this. */
const MIN_REFRESH_MS = 15_000;

export function useAppsHealth(): {
  health: AppsHealthMap;
  sharing: AppsSharingMap;
  refresh: () => void;
} {
  const [health, setHealth] = useState<AppsHealthMap>({});
  const [sharing, setSharing] = useState<AppsSharingMap>({});
  const lastFetch = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - lastFetch.current < MIN_REFRESH_MS) return;
    lastFetch.current = Date.now();
    try {
      const res = await fetch(`${GATEWAY}/api/apps/health`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        apps?: AppsHealthMap;
        sharing?: AppsSharingMap;
      };
      if (body.apps) setHealth(body.apps);
      if (body.sharing) setSharing(body.sharing);
    } catch {
      /* Health is decoration: an older gateway or offline gateway leaves cards as-is. */
    }
  }, []);

  useEffect(() => {
    void load(true);
    const onFocus = () => void load();
    // Background revalidation writes many cache entries in a burst; one refetch.
    let timer: number | undefined;
    const onPublishChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(true), 400);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(PUBLISH_STATE_CHANGED_EVENT, onPublishChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(PUBLISH_STATE_CHANGED_EVENT, onPublishChange);
    };
  }, [load]);

  return {
    health,
    sharing,
    refresh: useCallback(() => void load(true), [load]),
  };
}
