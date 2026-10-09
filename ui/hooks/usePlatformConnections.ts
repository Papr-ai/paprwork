/**
 * Browser sign-ins (Platform Connections): sites with no direct connection,
 * where Pen drives a signed-in Papr Chrome session on this Mac.
 *
 * State + actions only; Connections → Services renders them as rows.
 */

import { useCallback, useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";
import { openPlatformBrowserTab } from "../lib/openPlatformBrowserTab";
import { openChatWithPrompt } from "../utils/openChatWithPrompt";
import { buildSettingsPlatformSetupChatPrompt } from "../utils/onboardingPlatformSetupPrompt";
import {
  connectResultRequiresGoogleChrome,
  fetchGoogleChromeInstalled,
  type PlatformConnectData,
} from "../utils/platformHostCapabilities";

export type PlatformStatus = "connected" | "disconnected" | "expired" | "needs_reauth" | "connecting";

export interface PlatformSessionState {
  platformId: string;
  status: PlatformStatus;
  connectedAt?: string;
  lastRefreshedAt?: string;
  expiresAt?: string;
  error?: string;
}

export interface PlatformInfo {
  id: string;
  name: string;
  notes?: string;
  status: PlatformSessionState;
  isCustom?: boolean;
  homeUrl?: string;
  registeredBy?: "user" | "agent";
}

/** Built-in sites: their domain (for the logo) and what Pen can do there. */
export const PLATFORM_META: Record<string, { domain: string; desc: string }> = {
  linkedin: { domain: "linkedin.com", desc: "Posts, messages, profiles" },
  twitter: { domain: "x.com", desc: "Posts, replies, search" },
  reddit: { domain: "reddit.com", desc: "Posts, comments, subreddits" },
  instagram: { domain: "instagram.com", desc: "Posts, stories, messages" },
  facebook: { domain: "facebook.com", desc: "Pages, posts, messages" },
  tiktok: { domain: "tiktok.com", desc: "Videos, comments" },
  telegram: { domain: "telegram.org", desc: "Chats and channels" },
};

/** LinkedIn signs in through Papr's Chrome only; others can copy a session from personal Chrome. */
export function canImportFromChrome(platformId: string): boolean {
  return platformId !== "linkedin";
}

export function platformDomain(p: Pick<PlatformInfo, "id" | "homeUrl">): string {
  if (PLATFORM_META[p.id]) return PLATFORM_META[p.id].domain;
  try {
    return new URL(p.homeUrl ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const drop = (set: Set<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function usePlatformConnections() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const [externalChrome, setExternalChrome] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set when Connect failed because Google Chrome is missing: offer Set up with Pen. */
  const [needsChromeFor, setNeedsChromeFor] = useState<string | null>(null);
  /** null while checking the host. */
  const [chrome, setChrome] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await gateway.send("platform:get-all", {});
      setPlatforms((res.data as PlatformInfo[]) ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load website logins");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    let live = true;
    void fetchGoogleChromeInstalled().then((ok) => live && setChrome(ok));
    return () => {
      live = false;
    };
  }, [load]);

  // The gateway broadcasts session changes (sign-in detected, expired, refreshed).
  useEffect(() => {
    const onBroadcast = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; data?: unknown }>).detail;
      if (detail?.type !== "platform:status-changed" || !detail.data) return;
      const st = detail.data as PlatformSessionState;
      setPlatforms((prev) => prev.map((p) => (p.id === st.platformId ? { ...p, status: st } : p)));
      setBusy(null);
      if (st.status === "connected" || st.status === "disconnected") {
        setWaiting((w) => drop(w, st.platformId));
        setExternalChrome((w) => drop(w, st.platformId));
      }
      if (st.status !== "connected") setTimeout(() => void load(), 500);
    };
    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, [load]);

  const run = useCallback(
    async (id: string, fn: () => Promise<void>, fallback: string) => {
      setBusy(id);
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : fallback);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const setupWithPen = useCallback((id: string, name: string) => {
    setError(null);
    setNeedsChromeFor(null);
    openChatWithPrompt(buildSettingsPlatformSetupChatPrompt(name, id));
  }, []);

  const connect = useCallback(
    (id: string) =>
      run(
        id,
        async () => {
          setNotice(null);
          setNeedsChromeFor(null);
          const res = await gateway.send("platform:connect", { platformId: id });
          if (!res.success) throw new Error(res.error || "Couldn't connect");
          const data = res.data as PlatformConnectData;
          if (connectResultRequiresGoogleChrome(data)) {
            setNeedsChromeFor(id);
            throw new Error(data.error || "Google Chrome is required to sign in (passkeys need real Chrome).");
          }
          if (data?.error && data.status === "disconnected") throw new Error(data.error);
          if (data?.message) setNotice(data.message);
          if (data?.status === "connected") {
            await load();
            return;
          }
          if (data?.waitingForConfirmation) {
            setWaiting((w) => new Set(w).add(id));
            if (data.externalChrome) setExternalChrome((w) => new Set(w).add(id));
            else openPlatformBrowserTab(id);
            setPlatforms((prev) =>
              prev.map((p) => (p.id === id ? { ...p, status: { ...p.status, status: "connecting" } } : p)),
            );
          }
        },
        "Couldn't connect",
      ),
    [run, load],
  );

  const confirm = useCallback(
    (id: string) =>
      run(
        id,
        async () => {
          const res = await gateway.send("platform:confirm-login", { platformId: id });
          const data = res.data as PlatformSessionState;
          if (data?.status === "connected") {
            setWaiting((w) => drop(w, id));
            setExternalChrome((w) => drop(w, id));
          } else if (data?.error) {
            setError(data.error);
          }
          await load();
        },
        "Couldn't check the sign-in",
      ),
    [run, load],
  );

  const cancel = useCallback((id: string) => {
    setWaiting((w) => drop(w, id));
    setExternalChrome((w) => drop(w, id));
    setPlatforms((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: { ...p.status, status: "disconnected" } } : p)),
    );
  }, []);

  const disconnect = useCallback(
    (id: string) =>
      run(
        id,
        async () => {
          await gateway.send("platform:disconnect", { platformId: id });
          await load();
        },
        "Couldn't disconnect",
      ),
    [run, load],
  );

  const refresh = useCallback(
    (id: string) =>
      run(
        id,
        async () => {
          await gateway.send("platform:refresh", { platformId: id });
          await load();
        },
        "Couldn't refresh",
      ),
    [run, load],
  );

  /** Registers a site and returns its platform id, or null on failure. */
  const register = useCallback(
    async (url: string, name?: string): Promise<string | null> => {
      setBusy("__register");
      setError(null);
      try {
        const res = await gateway.send("platform:register", { url, name: name || undefined });
        if (!res.success) throw new Error(res.error || "Couldn't add the site");
        await load();
        return (res.data as { id?: string } | undefined)?.id ?? null;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add the site");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const remove = useCallback(
    (id: string) =>
      run(
        id,
        async () => {
          const res = await gateway.send("platform:unregister", { platformId: id });
          if (!res.success) throw new Error(res.error || "Couldn't remove the site");
          await load();
        },
        "Couldn't remove the site",
      ),
    [run, load],
  );

  /** Copies a session from personal Google Chrome (one Keychain prompt per site). */
  const importFromChrome = useCallback(
    (id: string) =>
      run(
        id,
        async () => {
          const res = await gateway.send("platform:import-from-chrome", { platformIds: [id] });
          if (!res.success) throw new Error(res.error || "Import failed");
          const result = ((res.data as { results?: PlatformSessionState[] })?.results ?? [])[0];
          if (result && result.status !== "connected") {
            throw new Error(result.error ?? "Not signed in to this site in Google Chrome.");
          }
          await load();
        },
        "Import from Chrome failed",
      ),
    [run, load],
  );

  return {
    platforms,
    loading,
    busy,
    waiting,
    externalChrome,
    error,
    notice,
    needsChromeFor,
    chrome,
    setError,
    connect,
    confirm,
    cancel,
    disconnect,
    refresh,
    register,
    remove,
    importFromChrome,
    setupWithPen,
  };
}

export type PlatformConnections = ReturnType<typeof usePlatformConnections>;
