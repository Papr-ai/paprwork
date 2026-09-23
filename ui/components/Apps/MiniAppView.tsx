import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { useApp } from "../../hooks/useApp";
import { useCloudPublish } from "../../hooks/useCloudPublish";
import { useGatewaySupervisorStatus } from "../../hooks/useGatewaySupervisorStatus";
import { trackEvent } from "../../lib/telemetry";
import { gateway } from "../../src/lib/gateway";
import type { ArtifactCloudLineage } from "../../stores/artifactsStore";
import { isCatalogPreviewEntityId } from "../../types/cloudCatalogPreviewTab";
import {
  MiniAppPublishBar,
  type AppPreviewMode,
} from "./MiniAppPublishBar";
import { MiniAppFilesView } from "./MiniAppFilesView";
import { MiniAppJobsView } from "./MiniAppJobsView";
import type { AppWorkspaceMode, AppWorkspacePanel } from "../../hooks/useAppWorkspace";
import { useAppLinkedJobCount } from "../../stores/jobsStore";
import { useTabs } from "../../hooks/useTabs";
import {
  clearCloudPreviewCookies,
  buildUpstreamPublishedWebUrl,
  parsePublishedAppUrl,
} from "../../utils/cloudDesktopPreview";
import { prepareCloudPreviewIframe } from "../../utils/cloudPreviewSession";
import { usePreviewTabLifecycle } from "../../utils/previewIframeLifecycle";
import { resyncAllPreviewFramePhases } from "../../utils/rendererPerformance";
import { isBenignPreviewFetchAbortMessage } from "../../utils/previewFetchAbort";
import { shouldSuppressMiniAppRuntimeBanner } from "../../utils/previewNetworkErrors";
import {
  normalizeMiniAppRuntimeErrorMessage,
  shouldShowDataSourcesMigrationHint,
} from "../../../src/core/utils/miniAppHttpError";
import { confirmRefreshIfNewRevision } from "../../utils/publishedAppRevisionCheck";
import {
  canLoadLocalAppPreview,
  isWaitingForLocalPreviewGateway,
} from "../../utils/localPreviewGatewayGate";
import {
  APP_LOOKUP_MAX_ATTEMPTS,
  APP_LOOKUP_RETRY_MS,
  appGetFailureUserMessage,
  classifyAppGetFailure,
} from "../../utils/appGetErrorMessage";
import { useCloudPreviewChatBridge } from "../../hooks/useCloudPreviewChatBridge";
import { resolveMiniAppPreviewOrigin } from "../../utils/miniAppPreviewOrigin";
import {
  MINI_APP_SHELL_ANNOUNCE_GRACE_MS,
  describeIsolationOutcome,
  isShellAnnouncementFor,
  miniAppShellLooksLikeError,
  readSameOriginDocument,
} from "../../utils/miniAppShellProbe";
import "./MiniAppPublishBar.css";

interface MiniAppViewProps {
  appId: string;
  /**
   * Preview fetch-gate phase: false when the window is backgrounded (sleep) or the
   * tab is off-screen in LRU — fetches pause, iframe may stay mounted.
   */
  previewTabVisible?: boolean;
  /** False when the tab is off-screen in LRU; true when this pane is shown (even if the window is backgrounded). */
  previewPaneActive?: boolean;
  /** True when this preview is in the LRU warm set — load iframe even while hidden. */
  previewKeepAliveWarm?: boolean;
  /** Hide publish bar — used when embedding the home dashboard in Home → Today. */
  embedded?: boolean;
}

export function MiniAppView({
  appId,
  previewTabVisible = true,
  previewPaneActive,
  previewKeepAliveWarm: _previewKeepAliveWarm = false,
  embedded = false,
}: MiniAppViewProps) {
  void _previewKeepAliveWarm;
  const paneActive = previewPaneActive ?? previewTabVisible;
  const { reloadKey, triggerReload } = useApp(appId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [appTitle, setAppTitle] = useState("Mini-app");
  const [cloudLineage, setCloudLineage] = useState<ArtifactCloudLineage | null>(null);
  const [viewMode, setViewMode] = useState<AppPreviewMode>("local");
  const [workspaceMode, setWorkspaceMode] = useState<AppWorkspaceMode>("preview");
  const [workspacePanel, setWorkspacePanel] = useState<AppWorkspacePanel>("code");
  const linkedJobCount = useAppLinkedJobCount(appId);
  const [previewShellLoaded, setPreviewShellLoaded] = useState(false);
  const [iframeLoadKey, setIframeLoadKey] = useState(0);
  const [publishedIframeBaseUrl, setPublishedIframeBaseUrl] = useState<string | null>(
    null,
  );
  const [publishedPreviewBootstrapping, setPublishedPreviewBootstrapping] =
    useState(false);
  const [iframeLoadError, setIframeLoadError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeBannerDismissed, setRuntimeBannerDismissed] = useState(false);
  const [appMissingInWorkspace, setAppMissingInWorkspace] = useState(false);
  const iframeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shellAnnounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloud = useCloudPublish(appId, appTitle);
  const { createTab, switchToTab } = useTabs();
  const { isReady: gatewaySupervisorReady, isStarting: gatewaySupervisorStarting } =
    useGatewaySupervisorStatus();
  const [gatewayConnected, setGatewayConnected] = useState(() =>
    gateway.isConnected(),
  );

  useEffect(() => {
    return gateway.onConnectionChange(setGatewayConnected);
  }, []);

  useEffect(() => {
    setWorkspacePanel("code");
  }, [appId]);

  const localPreviewOrigin = useMemo(
    () =>
      resolveMiniAppPreviewOrigin({
        appId,
        host: import.meta.env.VITE_GATEWAY_HOST || "localhost",
        port: import.meta.env.VITE_GATEWAY_PORT || "18789",
        isolationFlag: import.meta.env.VITE_PAPR_MINI_APP_ISOLATION,
      }),
    [appId],
  );
  const previewOriginIsolated = localPreviewOrigin.isolated;
  const localSrc = `${localPreviewOrigin.origin}/apps/${appId}/index.html`;

  const gatewayBaseUrl = useMemo(() => {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}`;
  }, []);

  const isTrackCollaborator =
    cloudLineage?.mode === "track" &&
    Boolean(cloudLineage.sourceNamespaceId && cloudLineage.sourceSlug);

  const upstreamLiveUrl = useMemo(() => {
    if (!isTrackCollaborator || !cloudLineage) return null;
    return buildUpstreamPublishedWebUrl({
      sourceNamespaceId: cloudLineage.sourceNamespaceId,
      sourceSlug: cloudLineage.sourceSlug,
    });
  }, [isTrackCollaborator, cloudLineage]);

  const publishedLiveUrl = useMemo(() => {
    if (isTrackCollaborator) {
      return upstreamLiveUrl;
    }
    return cloud.publishedWebUrl;
  }, [isTrackCollaborator, upstreamLiveUrl, cloud.publishedWebUrl]);

  const isPublishedPreview =
    viewMode === "published" &&
    ((isTrackCollaborator && !!upstreamLiveUrl) ||
      (cloud.live && !!cloud.publishedWebUrl));

  useCloudPreviewChatBridge(isPublishedPreview);

  useEffect(() => {
    if (!isPublishedPreview || !publishedLiveUrl) {
      setPublishedIframeBaseUrl(null);
      setPublishedPreviewBootstrapping(false);
      return;
    }

    let cancelled = false;
    setPublishedPreviewBootstrapping(true);
    setPublishedIframeBaseUrl(null);

    const parsed = parsePublishedAppUrl(publishedLiveUrl);
    const bootstrap = parsed
      ? prepareCloudPreviewIframe({
          namespaceId: parsed.namespaceId,
          slug: parsed.slug,
          shareToken: parsed.shareToken,
          liveUrl: publishedLiveUrl,
        })
      : Promise.resolve({
          iframeUrl: publishedLiveUrl,
          mode: "proxy" as const,
        });

    void bootstrap
      .then((resolved) => {
        if (cancelled) return;
        setPublishedIframeBaseUrl(resolved.iframeUrl);
        setPublishedPreviewBootstrapping(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPublishedIframeBaseUrl(publishedLiveUrl);
        setPublishedPreviewBootstrapping(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isPublishedPreview, publishedLiveUrl, iframeLoadKey]);

  const iframeSrc = useMemo(() => {
    if (isPublishedPreview) {
      if (!publishedIframeBaseUrl) {
        return null;
      }
      const url = new URL(publishedIframeBaseUrl);
      url.searchParams.set("_r", String(iframeLoadKey));
      return url.toString();
    }
    const url = new URL(localSrc);
    url.searchParams.set("_r", String(reloadKey));
    url.searchParams.set("_lk", String(iframeLoadKey));
    return url.toString();
  }, [
    localSrc,
    reloadKey,
    iframeLoadKey,
    isPublishedPreview,
    publishedIframeBaseUrl,
  ]);

  usePreviewTabLifecycle(iframeRef, previewTabVisible, appId, iframeSrc);

  useEffect(() => {
    setPreviewShellLoaded(false);
    setRuntimeError(null);
    setRuntimeBannerDismissed(false);
    setIframeLoadError(null);
  }, [appId, reloadKey, iframeLoadKey, viewMode, isPublishedPreview]);

  useEffect(() => {
    setRuntimeBannerDismissed(false);
  }, [runtimeError]);

  useEffect(() => {
    if (!paneActive) {
      setPreviewShellLoaded(false);
    }
  }, [paneActive]);

  /** Re-open the fetch gate when this pane becomes visible (tab switch / wake). */
  useEffect(() => {
    if (!paneActive || !previewTabVisible) {
      return;
    }
    resyncAllPreviewFramePhases();
  }, [paneActive, previewTabVisible, appId]);

  const scheduleIframeRetry = useCallback((reason: string) => {
    setIframeLoadError(reason);
    if (iframeRetryTimerRef.current) {
      clearTimeout(iframeRetryTimerRef.current);
    }
    iframeRetryTimerRef.current = setTimeout(() => {
      setIframeLoadKey((key) => key + 1);
    }, 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (iframeRetryTimerRef.current) {
        clearTimeout(iframeRetryTimerRef.current);
      }
      if (shellAnnounceTimerRef.current) {
        clearTimeout(shellAnnounceTimerRef.current);
      }
    };
  }, []);

  const markShellHealthy = useCallback(() => {
    if (shellAnnounceTimerRef.current) {
      clearTimeout(shellAnnounceTimerRef.current);
      shellAnnounceTimerRef.current = null;
    }
    setIframeLoadError(null);
    setRuntimeError(null);
    setPreviewShellLoaded(true);
  }, []);

  /**
   * Under a per-app origin we cannot read the document, so a healthy load is
   * proved by papr-app-bridge announcing rather than by inspecting the DOM.
   * Bounded, and expiry retries rather than erroring: an unregistered route is
   * "ask again" (Issue 98), not "this app is gone".
   */
  const awaitShellAnnouncement = useCallback(() => {
    if (shellAnnounceTimerRef.current) {
      clearTimeout(shellAnnounceTimerRef.current);
    }
    shellAnnounceTimerRef.current = setTimeout(() => {
      shellAnnounceTimerRef.current = null;
      scheduleIframeRetry("App routes not ready yet — retrying…");
    }, MINI_APP_SHELL_ANNOUNCE_GRACE_MS);
  }, [scheduleIframeRetry]);

  useEffect(() => {
    if (isPublishedPreview) return;

    const handleAnnouncement = (event: MessageEvent) => {
      if (!isShellAnnouncementFor(appId, event.data)) return;
      if (miniAppShellLooksLikeError(event.data)) {
        scheduleIframeRetry("App routes not ready yet — retrying…");
        return;
      }
      // The header is a request the browser may refuse without erroring, so
      // this is the only place the outcome is observable. Warn rather than
      // fail: a refused frame still works, it just shares our thread again.
      if (
        describeIsolationOutcome(
          previewOriginIsolated,
          event.data.originAgentCluster,
        ) === "refused"
      ) {
        console.warn(
          `[MiniAppView] App ${appId} asked for an isolated origin and the browser refused — this preview shares the chat UI's main thread.`,
        );
      }
      markShellHealthy();
    };

    window.addEventListener("message", handleAnnouncement);
    return () => window.removeEventListener("message", handleAnnouncement);
  }, [
    appId,
    isPublishedPreview,
    markShellHealthy,
    previewOriginIsolated,
    scheduleIframeRetry,
  ]);

  const localPreviewGatewayGate = useMemo(
    () => ({
      isPublishedPreview,
      iframeActivated: paneActive,
      gatewaySupervisorReady,
      gatewaySupervisorStarting,
      gatewayConnected,
    }),
    [
      isPublishedPreview,
      paneActive,
      gatewaySupervisorReady,
      gatewaySupervisorStarting,
      gatewayConnected,
    ],
  );

  const shouldLoadLocalIframe = canLoadLocalAppPreview(localPreviewGatewayGate);
  const waitingForGateway = isWaitingForLocalPreviewGateway(
    localPreviewGatewayGate,
  );

  const runAppGetProbe = useCallback(() => {
    if (!paneActive || !gatewayConnected || isCatalogPreviewEntityId(appId)) {
      return () => {};
    }

    setAppMissingInWorkspace(false);
    setIframeLoadError(null);

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const probe = async (attempt: number): Promise<void> => {
      const onFailure = (reason: string | undefined): void => {
        const kind = classifyAppGetFailure(reason);
        if (kind === "not_found") {
          setAppMissingInWorkspace(true);
          setIframeLoadError(appGetFailureUserMessage(kind));
          return;
        }

        if (attempt < APP_LOOKUP_MAX_ATTEMPTS) {
          setIframeLoadError(appGetFailureUserMessage(kind));
          retryTimer = setTimeout(() => {
            if (!cancelled) void probe(attempt + 1);
          }, APP_LOOKUP_RETRY_MS);
          return;
        }

        setIframeLoadError(
          "Could not reach the local gateway to load this app. Your app is " +
            "still on disk; reopen the tab once the gateway is running.",
        );
      };

      try {
        const resp = await gateway.send("app:get", { appId });
        if (cancelled) return;
        if (!resp.success) {
          onFailure(resp.error);
          return;
        }
        const data = resp.data as {
          title?: string;
          cloudLineage?: ArtifactCloudLineage;
        };
        const title = data?.title?.trim();
        if (title) setAppTitle(title);
        setCloudLineage(data?.cloudLineage ?? null);
        setAppMissingInWorkspace(false);
        setIframeLoadError(null);
      } catch (error) {
        if (cancelled) return;
        onFailure(error instanceof Error ? error.message : undefined);
      }
    };

    void probe(1);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [appId, paneActive, gatewayConnected]);

  useEffect(() => {
    return runAppGetProbe();
  }, [runAppGetProbe]);

  const lookupErrorLatchRef = useRef({
    missing: false,
    loadError: null as string | null,
  });
  lookupErrorLatchRef.current = {
    missing: appMissingInWorkspace,
    loadError: iframeLoadError,
  };

  useEffect(() => {
    if (!paneActive || !gatewayConnected || isCatalogPreviewEntityId(appId)) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string } | undefined;
      if (detail?.type !== "app:list-updated") {
        return;
      }
      const latch = lookupErrorLatchRef.current;
      if (!latch.missing && !latch.loadError) {
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runAppGetProbe();
      }, 400);
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => {
      window.removeEventListener("gateway-broadcast", handler);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [appId, paneActive, gatewayConnected, runAppGetProbe]);

  const refreshAppMetadata = async () => {
    try {
      const resp = await gateway.send("app:get", { appId });
      const data = resp.data as {
        title?: string;
        cloudLineage?: ArtifactCloudLineage;
      };
      const title = data?.title?.trim();
      if (title) {
        setAppTitle(title);
      }
      setCloudLineage(data?.cloudLineage ?? null);
    } catch {
      /* optional */
    }
    triggerReload();
  };

  useEffect(() => {
    if (!paneActive || isCatalogPreviewEntityId(appId)) {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | {
            type?: string;
            data?: { appId?: string; filename?: string };
          }
        | undefined;
      if (!detail) {
        return;
      }

      const isListUpdated = detail.type === "app:list-updated";
      const isMetadataFileChange =
        detail.type === "app:file-changed" &&
        detail.data?.appId === appId &&
        detail.data.filename?.replace(/\\/g, "/") === "metadata.json";
      if (!isListUpdated && !isMetadataFileChange) {
        return;
      }

      void (async () => {
        try {
          const resp = await gateway.send("app:get", { appId });
          if (!resp.success) {
            return;
          }
          const data = resp.data as { title?: string };
          const title = data?.title?.trim();
          if (title) {
            setAppTitle(title);
          }
        } catch {
          /* optional */
        }
      })();
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [appId, paneActive]);

  useEffect(() => {
    if (
      !isTrackCollaborator &&
      !cloud.live &&
      viewMode === "published"
    ) {
      setViewMode("local");
    }
  }, [cloud.live, viewMode, isTrackCollaborator]);

  const handleViewModeChange = useCallback(
    (mode: AppPreviewMode) => {
      if (mode === "local" && viewMode === "published") {
        clearCloudPreviewCookies();
        setIframeLoadKey((key) => key + 1);
      }
      setViewMode(mode);
    },
    [viewMode],
  );

  const handleRefreshPreview = useCallback(async () => {
    if (isPublishedPreview && iframeRef.current) {
      const proceed = await confirmRefreshIfNewRevision(
        iframeRef.current,
        iframeSrc,
      );
      if (!proceed) {
        return;
      }
    }
    triggerReload();
    setIframeLoadKey((key) => key + 1);
  }, [triggerReload, isPublishedPreview, iframeSrc]);

  useEffect(() => {
    const surface = isPublishedPreview ? "cloud" : "local";
    trackEvent("paprwork_app_opened", {
      app_id: appId,
      surface,
    } as Record<string, unknown>);
    // Track activation: result inspected (first time opening a created app)
    if (!localStorage.getItem("papr-activation-result-inspected")) {
      localStorage.setItem("papr-activation-result-inspected", "true");
      trackEvent("paprwork_activation_result_inspected", { app_id: appId } as Record<string, unknown>);
    }
    // Track activation: repeat value (second+ distinct app opened)
    const inspectedApps = JSON.parse(localStorage.getItem("papr-activation-inspected-apps") || "[]");
    if (!inspectedApps.includes(appId)) {
      inspectedApps.push(appId);
      localStorage.setItem("papr-activation-inspected-apps", JSON.stringify(inspectedApps));
      if (inspectedApps.length >= 2 && !localStorage.getItem("papr-activation-repeat-value")) {
        localStorage.setItem("papr-activation-repeat-value", "true");
        trackEvent("paprwork_activation_repeat_value", { apps_count: inspectedApps.length } as Record<string, unknown>);
      }
    }

    // Time spent is the one engagement question the desktop could not answer:
    // paprwork_app_closed was declared but never fired, so every app session
    // had an open with no close. Cleanup runs on unmount and on app switch,
    // which is exactly the close boundary we want.
    const openedAt = Date.now();
    return () => {
      trackEvent("paprwork_app_closed", {
        app_id: appId,
        time_open_ms: Date.now() - openedAt,
        surface,
      } as Record<string, unknown>);
    };
  }, [appId, isPublishedPreview]);

  // Inject paprAPI + runtime console forwarding for local preview only
  useEffect(() => {
    if (isPublishedPreview) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      // Fallback only. papr-app-bridge is injected server-side as a blocking
      // <script> in <head>, so on any HTML the gateway served this has already
      // run — earlier than here, which fires after every app script. Under a
      // per-app origin contentDocument is null and this no-ops entirely; the
      // bridge is the only path. Kept for HTML that reached the iframe without
      // passing through injectMiniAppPreviewFetchGate.
      const iframeDocument = iframe.contentDocument;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDocument || !iframeWindow) return;
      if ((iframeWindow as { paprAPI?: unknown }).paprAPI) return;

      const runtimeLogScript = iframeDocument.createElement("script");
      runtimeLogScript.textContent = `
        (function() {
          if (window.__paprRuntimeLogInstalled) return;
          window.__paprRuntimeLogInstalled = true;
          var appId = ${JSON.stringify(appId)};
          function send(level, message, source, line, column) {
            try {
              window.parent.postMessage({
                type: 'papr-runtime-log',
                appId: appId,
                entry: {
                  level: level,
                  message: String(message),
                  source: source || undefined,
                  line: line || undefined,
                  column: column || undefined,
                  timestamp: new Date().toISOString(),
                  origin: 'iframe'
                }
              }, '*');
            } catch (e) {}
          }
          window.addEventListener('error', function(e) {
            send('error', e.message || String(e.error), e.filename, e.lineno, e.colno);
          });
          window.addEventListener('unhandledrejection', function(e) {
            var reason = e.reason;
            var msg = reason && reason.message ? reason.message : String(reason);
            send('error', 'Unhandled rejection: ' + msg);
          });
          ['error', 'warn'].forEach(function(level) {
            var orig = console[level];
            if (!orig) return;
            console[level] = function() {
              var msg = Array.prototype.map.call(arguments, function(a) {
                if (a instanceof Error) return a.message;
                if (typeof a === 'object') {
                  try { return JSON.stringify(a); } catch (e) { return String(a); }
                }
                return String(a);
              }).join(' ');
              send(level, msg);
              return orig.apply(console, arguments);
            };
          });
        })();
      `;

      const paprScript = iframeDocument.createElement("script");
      paprScript.textContent = `
        window.__PAPR_APP_ID__ = ${JSON.stringify(appId)};
        window.paprAPI = {
          invoke: function(method, ...args) {
            return new Promise((resolve, reject) => {
              const messageId = 'papr-invoke-' + Date.now() + '-' + Math.random().toString(36).substring(7);
              const handler = (event) => {
                if (event.data?.type === 'papr-invoke-response' && event.data.id === messageId) {
                  window.removeEventListener('message', handler);
                  if (event.data.error) reject(new Error(event.data.error));
                  else resolve(event.data.result);
                }
              };
              window.addEventListener('message', handler);
              setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error('Electron API call timed out: ' + method));
              }, 10000);
              window.parent.postMessage({
                type: 'papr-invoke-request',
                id: messageId,
                appId: '${appId}',
                method: method,
                args: args
              }, '*');
            });
          }
        };
        window.paprFeatures = {
          getAvailability: function() {
            return fetch('/api/apps/' + encodeURIComponent(window.__PAPR_APP_ID__) + '/feature-availability')
              .then(function(res) {
                if (!res.ok) throw new Error('Feature availability request failed');
                return res.json();
              });
          }
        };
      `;

      const head = iframeDocument.head;
      if (head?.firstChild) {
        head.insertBefore(runtimeLogScript, head.firstChild);
        head.insertBefore(paprScript, runtimeLogScript.nextSibling);
      } else if (head) {
        head.appendChild(runtimeLogScript);
        head.appendChild(paprScript);
      }
    };

    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [appId, reloadKey, isPublishedPreview]);

  useEffect(() => {
    const handleAgentRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ appId?: string }>).detail;
      if (detail?.appId === appId) {
        triggerReload();
      }
    };
    window.addEventListener("papr-app-agent-refresh", handleAgentRefresh);
    return () =>
      window.removeEventListener("papr-app-agent-refresh", handleAgentRefresh);
  }, [appId, triggerReload]);

  useEffect(() => {
    if (isPublishedPreview) return;

    const handleRuntimeLog = (event: MessageEvent) => {
      if (event.data?.type !== "papr-runtime-log") return;
      if (event.data.appId !== appId) return;
      const entry = event.data.entry as {
        level?: string;
        message?: string;
        source?: string;
        line?: number;
        column?: number;
        timestamp?: string;
        origin?: string;
      };
      if (!entry?.message) return;
      if (entry.level === "error") {
        const message = entry.message.trim();
        if (message.length === 0 || isBenignPreviewFetchAbortMessage(message)) {
          return;
        }
        if (
          shouldSuppressMiniAppRuntimeBanner({
            message,
            waitingForGateway,
            gatewaySupervisorStarting,
            gatewaySupervisorReady,
          })
        ) {
          return;
        }
        setRuntimeError(normalizeMiniAppRuntimeErrorMessage(message));
      }
      void gateway
        .send("app:runtime-log", {
          appId,
          entry: {
            level: entry.level ?? "log",
            message: entry.message,
            source: entry.source,
            line: entry.line,
            column: entry.column,
            timestamp: entry.timestamp,
            origin: "iframe",
          },
        })
        .catch(() => {
          /* best-effort */
        });
    };

    window.addEventListener("message", handleRuntimeLog);
    return () => window.removeEventListener("message", handleRuntimeLog);
  }, [
    appId,
    isPublishedPreview,
    waitingForGateway,
    gatewaySupervisorStarting,
    gatewaySupervisorReady,
  ]);

  useEffect(() => {
    if (isPublishedPreview) return;

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type !== "papr-invoke-request") return;
      if (event.data.appId !== appId) return;

      const { id, method, args } = event.data;

      try {
        if (!window.electronAPI?.system?.invoke) {
          throw new Error("electronAPI.system.invoke not available");
        }
        const result = await window.electronAPI.system.invoke(method, args);
        iframeRef.current?.contentWindow?.postMessage(
          { type: "papr-invoke-response", id, result },
          "*",
        );
      } catch (error) {
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: "papr-invoke-response",
            id,
            error: (error as Error).message,
          },
          "*",
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [appId, isPublishedPreview]);

  // Auth0 login cannot run inside an iframe — open apps.papr.ai sign-in externally.
  //
  // Note this has never actually fired: it is gated on isPublishedPreview, whose
  // iframe is apps.papr.ai and therefore already cross-origin, so
  // contentDocument is null and the querySelectorAll below is unreachable. Left
  // as-is rather than removed — mini-app isolation does not touch this path, and
  // the real fix is for the published host to intercept its own links.
  useEffect(() => {
    if (!isPublishedPreview) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelectorAll('a[href*="/auth/login"]').forEach((node) => {
          const anchor = node as HTMLAnchorElement;
          anchor.addEventListener("click", (event) => {
            event.preventDefault();
            const href = anchor.href;
            if (!href) return;
            if (window.electronAPI?.system?.invoke) {
              void window.electronAPI.system.invoke("shell.openExternal", href);
            } else {
              window.open(href, "_blank", "noopener,noreferrer");
            }
          });
        });
      } catch {
        /* cross-origin — ignore */
      }
    };

    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [isPublishedPreview, iframeSrc]);

  return (
    <div
      className={`mini-app-view${embedded ? " mini-app-view--embedded" : ""}`}
    >
      {!embedded ? (
        <MiniAppPublishBar
          appId={appId}
          appTitle={appTitle}
          cloud={cloud}
          cloudLineage={cloudLineage}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          workspaceMode={workspaceMode}
          onWorkspaceModeChange={(mode) => {
            setWorkspaceMode(mode);
            if (mode === "files") {
              setWorkspacePanel("code");
            }
          }}
          workspacePanel={workspacePanel}
          onWorkspacePanelChange={setWorkspacePanel}
          linkedJobCount={linkedJobCount}
          onTrackPullComplete={() => void refreshAppMetadata()}
          onRefreshPreview={handleRefreshPreview}
          previewTabVisible={previewTabVisible}
          previewShellLoaded={previewShellLoaded}
          onOpenDependencyApp={(dependencyAppId, title) => {
            const tabId = createTab("app", dependencyAppId, title ?? "App");
            switchToTab(tabId);
          }}
        />
      ) : null}
      {!embedded && workspaceMode === "files" ? (
        workspacePanel === "jobs" ? (
          <MiniAppJobsView appId={appId} appTitle={appTitle} />
        ) : (
          <MiniAppFilesView appId={appId} panel={workspacePanel} />
        )
      ) : (
        <div className="mini-app-view__frame-wrap">
          {waitingForGateway ? (
            <div className="mini-app-view__overlay">
              <p>Gateway is starting — app preview will load when ready…</p>
            </div>
          ) : null}
          {shouldLoadLocalIframe || (isPublishedPreview && iframeSrc) ? (
            !appMissingInWorkspace ? (
            <iframe
              ref={iframeRef}
              key={`${appId}-${viewMode}-${isPublishedPreview ? publishedLiveUrl : reloadKey}-${iframeLoadKey}`}
              className="mini-app-view__frame"
              src={iframeSrc}
              title={`mini-app-${appId}`}
              name={previewTabVisible ? "papr-preview:visible" : "papr-preview:hidden"}
              sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              allow="microphone; camera"
              onLoad={() => {
                iframeRef.current?.contentWindow?.postMessage({
                  type: previewTabVisible ? "papr:preview-visible" : "papr:preview-hidden",
                }, iframeSrc ? new URL(iframeSrc).origin : "*");
                if (isPublishedPreview) return;
                const doc = readSameOriginDocument(iframeRef.current);
                if (doc) {
                  if (
                    miniAppShellLooksLikeError({
                      title: doc.title,
                      bodyText: doc.body?.innerText?.slice(0, 200),
                    })
                  ) {
                    scheduleIframeRetry("App routes not ready yet — retrying…");
                    return;
                  }
                  markShellHealthy();
                  return;
                }
                // Document unreadable (an isolated origin), so wait for the
                // bridge to announce instead of assuming health. Silence past
                // the grace window means the response was not ours (an
                // unregistered route) — retry, which is what that case needs.
                awaitShellAnnouncement();
              }}
              onError={() => {
                if (!isPublishedPreview) {
                  scheduleIframeRetry("Could not load app preview — retrying…");
                }
              }}
            />
            ) : null
          ) : null}
          {!waitingForGateway &&
          paneActive &&
          !isPublishedPreview &&
          !shouldLoadLocalIframe ? (
            <div className="mini-app-view__overlay mini-app-view__overlay--hint">
              <p>
                Local preview is paused while this tab is in the background. Select
                this app again to reload.
              </p>
              <button
                type="button"
                className="mini-app-view__runtime-banner-btn"
                onClick={() => {
                  setIframeLoadKey((key) => key + 1);
                  resyncAllPreviewFramePhases();
                }}
              >
                Reload preview
              </button>
            </div>
          ) : null}
          {appMissingInWorkspace && !waitingForGateway ? (
            <div className="mini-app-view__overlay mini-app-view__overlay--hint">
              <p>
                This app is not available in the current workspace. Close this tab
                or switch to the workspace where it lives.
              </p>
            </div>
          ) : null}
          {publishedPreviewBootstrapping ? (
            <div className="mini-app-view__overlay">
              <p>Connecting to apps.papr.ai…</p>
            </div>
          ) : null}
          {runtimeError && !waitingForGateway && !runtimeBannerDismissed ? (
            <div
              className="mini-app-view__runtime-banner"
              role="alert"
              aria-live="polite"
            >
              <div className="mini-app-view__runtime-banner-body">
                <p className="mini-app-view__runtime-banner-title">
                  Something went wrong
                </p>
                <pre className="mini-app-view__runtime-banner-message">
                  {runtimeError}
                </pre>
                {!isBenignPreviewFetchAbortMessage(runtimeError) &&
                shouldShowDataSourcesMigrationHint(runtimeError) ? (
                  <p className="mini-app-view__runtime-banner-hint">
                    This can mean a linked database path is missing after workspace
                    migration. Check the Apps page warning icon or ask the agent to
                    fix data-sources.json.
                  </p>
                ) : null}
              </div>
              <div className="mini-app-view__runtime-banner-actions">
                <button
                  type="button"
                  className="mini-app-view__runtime-banner-btn"
                  onClick={() => {
                    triggerReload();
                    setRuntimeBannerDismissed(true);
                  }}
                >
                  Reload
                </button>
                <button
                  type="button"
                  className="mini-app-view__runtime-banner-btn mini-app-view__runtime-banner-btn--ghost"
                  onClick={() => setRuntimeBannerDismissed(true)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {iframeLoadError && !waitingForGateway ? (
            <div
              className="mini-app-view__status-banner"
              role="status"
              aria-live="polite"
            >
              <p>{iframeLoadError}</p>
            </div>
          ) : null}
          {viewMode === "published" && !cloud.live ? (
            <div className="mini-app-view__overlay">
              <p>Publish this app to preview it on {cloud.appsHost}.</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
