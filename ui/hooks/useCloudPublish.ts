/**
 * Cloud publish state for a single mini-app (Settings bar + publish toolbar).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  accessModeToSharingSettings,
  formatShareLink,
  sharingSettingsRequireShareToken,
  type CloudExternalLink,
  type CloudLoginAccess,
} from "../utils/cloudShareLink";
import {
  audienceModelToPublishPrefs,
  sharingToAudienceModel,
  type CodeAccess,
  type ShareAudienceModel,
} from "../utils/shareAudienceModel";
import {
  fetchCloudPublishState,
  patchCloudPublishPrefs,
  publishCloudApp,
  unpublishCloudApp,
  type CloudPublishState,
} from "../utils/cloudPublishApi";
import {
  readCachedCloudPublishState,
  writeCachedCloudPublishState,
} from "../utils/cloudPublishCache";

export interface CloudPublishViewModel {
  loading: boolean;
  /** True while revalidating publish state when cached data is already shown. */
  refreshing: boolean;
  busy: boolean;
  error: string | null;
  toast: string | null;
  enabled: boolean;
  live: boolean;
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
  codeAccess: CodeAccess;
  shareUrl: string | null;
  loginUrl: string | null;
  externalLinkUrl: string | null;
  /** Best URL to load the live cloud app (iframe or browser). */
  publishedPreviewUrl: string | null;
  slug: string | null;
  statusLabel: string;
  appsHost: string;
}

function resolveSharing(state: CloudPublishState | null): {
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
  codeAccess: CodeAccess;
} {
  if (!state) {
    return { loginAccess: "private", externalLink: "off", codeAccess: "off" };
  }
  const codeAccess = state.prefs?.codeAccess ?? "off";
  if (state.loginAccess !== undefined || state.externalLink !== undefined) {
    return {
      loginAccess: state.loginAccess ?? "private",
      externalLink: state.externalLink ?? "off",
      codeAccess,
    };
  }
  const legacy = accessModeToSharingSettings(state.accessMode as CloudLoginAccess);
  return { ...legacy, codeAccess };
}

function buildViewModel(
  state: CloudPublishState | null,
  loading: boolean,
  refreshing: boolean,
  busy: boolean,
  error: string | null,
  toast: string | null,
): CloudPublishViewModel {
  const sharing = resolveSharing(state);
  const token = state?.shareToken ?? null;
  const baseUrl = state?.shareUrl ?? null;
  const externalEnabled = sharingSettingsRequireShareToken(sharing);
  const shareLink =
    formatShareLink(baseUrl, token, state?.accessMode, externalEnabled) ??
    baseUrl;
  const externalLinkUrl =
    externalEnabled && shareLink?.includes("?t=") ? shareLink : null;
  const loginUrl =
    sharing.loginAccess === "none"
      ? null
      : externalLinkUrl
        ? baseUrl
        : shareLink ?? baseUrl;

  const loginLabel =
    sharing.loginAccess === "private"
      ? "Private"
      : sharing.loginAccess === "team"
        ? "Team"
        : sharing.loginAccess === "public"
          ? "Public"
          : null;
  const linkLabel =
    sharing.externalLink === "read"
      ? "Invite (view)"
      : sharing.externalLink === "read_write"
        ? "Invite (use app)"
        : null;
  const codeLabel = sharing.codeAccess === "install" ? "Code install" : null;
  const statusParts = [loginLabel, linkLabel, codeLabel].filter(Boolean);

  const publishedPreviewUrl = (() => {
    if (!baseUrl || state?.enabled !== true) return null;
    if (sharing.loginAccess === "none" && externalLinkUrl) {
      return externalLinkUrl;
    }
    return loginUrl ?? shareLink ?? baseUrl;
  })();

  return {
    loading,
    refreshing,
    busy,
    error,
    toast,
    enabled: state?.enabled === true,
    live: state?.enabled === true && !!state.shareUrl,
    loginAccess: sharing.loginAccess,
    externalLink: sharing.externalLink,
    codeAccess: sharing.codeAccess,
    shareUrl: baseUrl,
    loginUrl,
    externalLinkUrl,
    publishedPreviewUrl,
    slug: state?.slug ?? null,
    statusLabel:
      statusParts.length > 0 ? statusParts.join(" · ") : "Not shared",
    appsHost: "apps.papr.ai",
  };
}

export function useCloudPublish(appId: string, appTitle?: string) {
  const cachedOnMount = readCachedCloudPublishState(appId);
  const [state, setState] = useState<CloudPublishState | null>(cachedOnMount);
  const [loading, setLoading] = useState(cachedOnMount === null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const hasDisplayedStateRef = useRef(cachedOnMount !== null);

  const applyPublishState = useCallback((next: CloudPublishState | null) => {
    setState(next);
    hasDisplayedStateRef.current = next !== null;
    writeCachedCloudPublishState(appId, next);
  }, [appId]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      if (hasDisplayedStateRef.current) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      const next = await fetchCloudPublishState(appId);
      applyPublishState(next);
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [appId, applyPublishState]);

  useEffect(() => {
    const cached = readCachedCloudPublishState(appId);
    if (cached) {
      setState(cached);
      hasDisplayedStateRef.current = true;
      setLoading(false);
    } else {
      setState(null);
      hasDisplayedStateRef.current = false;
      setLoading(true);
    }
    void refresh();
  }, [appId, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const updateSharing = useCallback(
    async (model: ShareAudienceModel) => {
      setBusy(true);
      setError(null);
      try {
        const { sharing, codeAccess } = audienceModelToPublishPrefs(model);
        const needsCloudPublish =
          model.permission !== "edit" || model.audience !== "private";

        if (needsCloudPublish) {
          const result = await publishCloudApp(appId, {
            ...sharing,
            codeAccess,
          });
          applyPublishState(result);
        } else {
          const prefs = await patchCloudPublishPrefs(appId, { codeAccess: "off" });
          setState((prev) => {
            if (!prev) return prev;
            const next = {
              ...prev,
              prefs: { ...prev.prefs, ...prefs, codeAccess: "off" },
            };
            writeCachedCloudPublishState(appId, next);
            return next;
          });
        }
        setToast(`${appTitle ?? "App"} sharing updated`);
      } catch (err) {
        setError((err as Error).message.slice(0, 160));
      } finally {
        setBusy(false);
      }
    },
    [appId, appTitle, applyPublishState],
  );

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const sharing = resolveSharing(state);
      const result = await publishCloudApp(appId, sharing);
      applyPublishState(result);
      setToast(`${appTitle ?? "App"} published to ${result.shareUrl ?? "cloud"}`);
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }, [appId, appTitle, state, applyPublishState]);

  const unpublish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await unpublishCloudApp(appId);
      applyPublishState(null);
      setToast(`${appTitle ?? "App"} unpublished`);
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }, [appId, appTitle, applyPublishState]);

  const copyLink = useCallback(async (link: string | null) => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setToast("Link copied");
    } catch {
      setError("Could not copy link");
    }
  }, []);

  const openInBrowser = useCallback(async (link: string | null) => {
    if (!link) return;
    try {
      if (window.electronAPI?.system?.invoke) {
        await window.electronAPI.system.invoke("shell.openExternal", link);
      } else {
        window.open(link, "_blank", "noopener,noreferrer");
      }
    } catch {
      setError("Could not open link");
    }
  }, []);

  const viewModel = buildViewModel(state, loading, refreshing, busy, error, toast);

  return {
    ...viewModel,
    refresh,
    updateSharing,
    publish,
    unpublish,
    copyLink,
    openInBrowser,
    shareModel: sharingToAudienceModel(
      viewModel.loginAccess,
      viewModel.externalLink,
      viewModel.codeAccess,
    ),
  };
}
