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
  type CloudPublishPrefs,
  type CloudPublishState,
} from "../utils/cloudPublishApi";
import type { CloudUploadModePref } from "../utils/appUploadMode";
import { uploadModeFromToggle } from "../utils/appUploadMode";
import type { CloudCompatibilityReport } from "../../src/core/types/cloudAppCompatibility";
import {
  readCachedCloudPublishState,
  writeCachedCloudPublishState,
} from "../utils/cloudPublishCache";
import {
  buildDesktopCloudPreviewUrl,
  isDesktopElectron,
} from "../utils/cloudDesktopPreview";

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
  /** Public apps.papr.ai URL (for display, copy, open in browser). */
  publishedWebUrl: string | null;
  /** Iframe src for Web preview (gateway proxy on desktop, direct URL elsewhere). */
  publishedPreviewUrl: string | null;
  slug: string | null;
  statusLabel: string;
  appsHost: string;
  compatibility: CloudCompatibilityReport | null;
  uploadMode: CloudUploadModePref;
  autoUploadSaving: boolean;
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

  const publishedWebUrl =
    baseUrl && state?.enabled === true
      ? (externalLinkUrl ?? loginUrl ?? shareLink ?? baseUrl)
      : null;

  const publishedPreviewUrl = (() => {
    if (!publishedWebUrl) return null;
    if (isDesktopElectron()) {
      const proxied = buildDesktopCloudPreviewUrl(publishedWebUrl);
      if (proxied) return proxied;
    }
    return publishedWebUrl;
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
    publishedWebUrl,
    publishedPreviewUrl,
    slug: state?.slug ?? null,
    statusLabel:
      statusParts.length > 0 ? statusParts.join(" · ") : "Not shared",
    appsHost: "apps.papr.ai",
    compatibility: state?.compatibility ?? null,
    uploadMode: (state?.prefs?.uploadMode ?? "inherit") as CloudUploadModePref,
    autoUploadSaving: false,
  };
}

function publishStateMatchesApp(
  targetAppId: string,
  state: CloudPublishState | null,
): boolean {
  if (!state) {
    return true;
  }
  return !state.appId || state.appId === targetAppId;
}

export function useCloudPublish(appId: string, appTitle?: string) {
  const cachedOnMount = readCachedCloudPublishState(appId);
  const [state, setState] = useState<CloudPublishState | null>(cachedOnMount);
  const [loading, setLoading] = useState(cachedOnMount === null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoUploadSaving, setAutoUploadSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const hasDisplayedStateRef = useRef(cachedOnMount !== null);
  const appIdRef = useRef(appId);
  const fetchGenerationRef = useRef(0);

  appIdRef.current = appId;

  const applyPublishState = useCallback(
    (targetAppId: string, next: CloudPublishState | null) => {
      if (targetAppId !== appIdRef.current) {
        return;
      }
      if (!publishStateMatchesApp(targetAppId, next)) {
        return;
      }
      setState(next);
      hasDisplayedStateRef.current = next !== null;
      writeCachedCloudPublishState(targetAppId, next);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const targetAppId = appIdRef.current;
    const generation = ++fetchGenerationRef.current;

    try {
      setError(null);
      if (hasDisplayedStateRef.current) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      const next = await fetchCloudPublishState(targetAppId);
      if (
        generation !== fetchGenerationRef.current ||
        targetAppId !== appIdRef.current
      ) {
        return;
      }
      if (!publishStateMatchesApp(targetAppId, next)) {
        return;
      }
      applyPublishState(targetAppId, next);
    } catch (err) {
      if (
        generation !== fetchGenerationRef.current ||
        targetAppId !== appIdRef.current
      ) {
        return;
      }
      setError((err as Error).message.slice(0, 160));
    } finally {
      if (
        generation === fetchGenerationRef.current &&
        targetAppId === appIdRef.current
      ) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyPublishState]);

  useEffect(() => {
    fetchGenerationRef.current += 1;

    setBusy(false);
    setError(null);
    setToast(null);

    const cached = readCachedCloudPublishState(appId);
    if (cached && publishStateMatchesApp(appId, cached)) {
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
    async (
      model: ShareAudienceModel,
      options?: { acknowledgeDesktopOnly?: boolean },
    ) => {
      setBusy(true);
      setError(null);
      try {
        const { sharing, codeAccess } = audienceModelToPublishPrefs(model);
        const needsCloudPublish =
          model.permission !== "edit" || model.audience !== "private";

        const targetAppId = appIdRef.current;
        if (needsCloudPublish) {
          const result = await publishCloudApp(targetAppId, {
            ...sharing,
            codeAccess,
            acknowledgeDesktopOnly: options?.acknowledgeDesktopOnly,
          });
          applyPublishState(targetAppId, result);
        } else {
          const prefs = await patchCloudPublishPrefs(targetAppId, {
            codeAccess: "off",
          });
          if (targetAppId !== appIdRef.current) {
            return;
          }
          setState((prev) => {
            if (!prev || !publishStateMatchesApp(targetAppId, prev)) {
              return prev;
            }
            const next = {
              ...prev,
              prefs: { ...prev.prefs, ...prefs, codeAccess: "off" },
            };
            writeCachedCloudPublishState(targetAppId, next);
            return next;
          });
        }
        setToast(`${appTitle ?? "App"} sharing updated`);
        window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));
      } catch (err) {
        setError((err as Error).message.slice(0, 160));
      } finally {
        setBusy(false);
      }
    },
    [appTitle, applyPublishState],
  );

  const publish = useCallback(
    async (options?: { acknowledgeDesktopOnly?: boolean }) => {
      setBusy(true);
      setError(null);
      try {
        const targetAppId = appIdRef.current;
        const sharing = resolveSharing(state);
        const result = await publishCloudApp(targetAppId, {
          ...sharing,
          acknowledgeDesktopOnly: options?.acknowledgeDesktopOnly,
        });
        applyPublishState(targetAppId, result);
        setToast(`${appTitle ?? "App"} published to ${result.shareUrl ?? "cloud"}`);
        window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));
      } catch (err) {
        setError((err as Error).message.slice(0, 160));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [appTitle, state, applyPublishState],
  );

  const unpublish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const targetAppId = appIdRef.current;
      await unpublishCloudApp(targetAppId);
      applyPublishState(targetAppId, null);
      setToast(`${appTitle ?? "App"} unpublished`);
      window.dispatchEvent(new CustomEvent("papr-community-catalog-refresh"));
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }, [appTitle, applyPublishState]);

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

  const setAutoUploadEnabled = useCallback(async (enabled: boolean) => {
    setAutoUploadSaving(true);
    setError(null);
    try {
      const targetAppId = appIdRef.current;
      const uploadMode = uploadModeFromToggle(enabled);
      const prefs = await patchCloudPublishPrefs(targetAppId, { uploadMode });
      if (targetAppId !== appIdRef.current) {
        return;
      }
      setState((prev) => {
        if (!prev || !publishStateMatchesApp(targetAppId, prev)) {
          return prev;
        }
        const next: CloudPublishState = {
          ...prev,
          prefs: { ...prev.prefs, ...prefs } as CloudPublishPrefs,
        };
        writeCachedCloudPublishState(targetAppId, next);
        return next;
      });
      setToast(
        enabled
          ? "This app will upload changes automatically"
          : "You'll upload this app manually with Upload now",
      );
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setAutoUploadSaving(false);
    }
  }, []);

  const viewModel = buildViewModel(state, loading, refreshing, busy, error, toast);
  viewModel.autoUploadSaving = autoUploadSaving;

  return {
    ...viewModel,
    refresh,
    updateSharing,
    publish,
    unpublish,
    copyLink,
    openInBrowser,
    setAutoUploadEnabled,
    shareModel: sharingToAudienceModel(
      viewModel.loginAccess,
      viewModel.externalLink,
      viewModel.codeAccess,
    ),
  };
}
