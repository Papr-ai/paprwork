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
import { useJobs } from "../../hooks/useJobs";
import {
  clearCloudPreviewCookies,
  buildUpstreamPublishedWebUrl,
  parsePublishedAppUrl,
} from "../../utils/cloudDesktopPreview";
import { prepareCloudPreviewIframe } from "../../utils/cloudPreviewSession";
import { usePreviewTabLifecycle } from "../../utils/previewIframeLifecycle";
import { confirmRefreshIfNewRevision } from "../../utils/publishedAppRevisionCheck";
import "./MiniAppPublishBar.css";

interface MiniAppViewProps {
  appId: string;
  /** False when preview tab is backgrounded but still LRU-mounted. */
  previewTabVisible?: boolean;
  /** Hide publish bar — used when embedding the home dashboard in Home → Today. */
  embedded?: boolean;
}

export function MiniAppView({
  appId,
  previewTabVisible = true,
  embedded = false,
}: MiniAppViewProps) {
  const { reloadKey, triggerReload } = useApp(appId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [appTitle, setAppTitle] = useState("Mini-app");
  const [cloudLineage, setCloudLineage] = useState<ArtifactCloudLineage | null>(null);
  const [viewMode, setViewMode] = useState<AppPreviewMode>("local");
  const [workspaceMode, setWorkspaceMode] = useState<AppWorkspaceMode>("preview");
  const [workspacePanel, setWorkspacePanel] = useState<AppWorkspacePanel>("code");
  const { graph } = useJobs();
  const linkedJobCount = graph?.appLinks[appId]?.jobIds.length ?? 0;
  const [iframeLoadKey, setIframeLoadKey] = useState(0);
  const [publishedIframeBaseUrl, setPublishedIframeBaseUrl] = useState<string | null>(
    null,
  );
  const [publishedPreviewBootstrapping, setPublishedPreviewBootstrapping] =
    useState(false);
  const [iframeLoadError, setIframeLoadError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [appMissingInWorkspace, setAppMissingInWorkspace] = useState(false);
  const iframeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloud = useCloudPublish(appId, appTitle);
  const { isReady: gatewaySupervisorReady, isStarting: gatewaySupervisorStarting, status: gatewaySupervisorStatus } =
    useGatewaySupervisorStatus();
  const prevGatewaySupervisorReadyRef = useRef(gatewaySupervisorReady);

  useEffect(() => {
    setWorkspacePanel("code");
  }, [appId]);

  const localSrc = useMemo(() => {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}/apps/${appId}/index.html`;
  }, [appId]);

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

  // Debounced cloud→local Turso pull when opening local preview (scoped to this app).
  useEffect(() => {
    if (isPublishedPreview || viewMode !== "local" || !appId) {
      return;
    }
    void fetch(`${gatewayBaseUrl}/api/apps/${appId}/sync-from-cloud`, {
      method: "POST",
    }).catch(() => {
      // Non-blocking — stale data until next sync trigger
    });
  }, [appId, gatewayBaseUrl, isPublishedPreview, viewMode]);

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

  usePreviewTabLifecycle(iframeRef, previewTabVisible);

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
    };
  }, []);

  useEffect(() => {
    const wasReady = prevGatewaySupervisorReadyRef.current;
    prevGatewaySupervisorReadyRef.current = gatewaySupervisorReady;
    if (gatewaySupervisorReady && !wasReady && !isPublishedPreview) {
      setIframeLoadError(null);
      setIframeLoadKey((key) => key + 1);
    }
  }, [gatewaySupervisorReady, isPublishedPreview]);

  const shouldLoadLocalIframe =
    !isPublishedPreview &&
    (gatewaySupervisorReady || gatewaySupervisorStatus === "unknown");

  useEffect(() => {
    setAppMissingInWorkspace(false);
    setIframeLoadError(null);
    setRuntimeError(null);
    if (isCatalogPreviewEntityId(appId)) {
      return;
    }
    void (async () => {
      try {
        const resp = await gateway.send("app:get", { appId });
        if (!resp.success) {
          setAppMissingInWorkspace(true);
          setIframeLoadError(
            "This app is not in the current workspace. Close this tab or switch back to the workspace where it lives.",
          );
          return;
        }
        const data = resp.data as {
          title?: string;
          cloudLineage?: ArtifactCloudLineage;
        };
        const title = data?.title?.trim();
        if (title) setAppTitle(title);
        setCloudLineage(data?.cloudLineage ?? null);
      } catch {
        setAppMissingInWorkspace(true);
        setIframeLoadError(
          "This app is not in the current workspace. Close this tab or switch back to the workspace where it lives.",
        );
      }
    })();
  }, [appId]);

  const refreshAppMetadata = async () => {
    try {
      const resp = await gateway.send("app:get", { appId });
      const data = resp.data as { cloudLineage?: ArtifactCloudLineage };
      setCloudLineage(data?.cloudLineage ?? null);
    } catch {
      /* optional */
    }
    triggerReload();
  };

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
      const iframeDocument = iframe.contentDocument;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDocument || !iframeWindow) return;

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
        if (message.length > 0) {
          setRuntimeError(message);
        }
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
  }, [appId, isPublishedPreview]);

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
          {gatewaySupervisorStarting && !isPublishedPreview ? (
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
              sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              allow="microphone; camera"
              onLoad={() => {
                if (isPublishedPreview) return;
                const doc = iframeRef.current?.contentDocument;
                const title = doc?.title?.toLowerCase() ?? "";
                const bodyText = doc?.body?.innerText?.slice(0, 200).toLowerCase() ?? "";
                if (
                  title.includes("error") ||
                  bodyText.includes("cannot get /apps/")
                ) {
                  scheduleIframeRetry("App routes not ready yet — retrying…");
                  return;
                }
                setIframeLoadError(null);
                setRuntimeError(null);
              }}
              onError={() => {
                if (!isPublishedPreview) {
                  scheduleIframeRetry("Could not load app preview — retrying…");
                }
              }}
            />
            ) : null
          ) : null}
          {publishedPreviewBootstrapping ? (
            <div className="mini-app-view__overlay">
              <p>Connecting to apps.papr.ai…</p>
            </div>
          ) : null}
          {runtimeError && !gatewaySupervisorStarting ? (
            <div className="mini-app-view__overlay mini-app-view__overlay--hint">
              <p className="mini-app-view__runtime-error-title">App failed to load</p>
              <pre className="mini-app-view__runtime-error">{runtimeError}</pre>
              <p className="mini-app-view__runtime-error-hint">
                This often means a linked database path is missing after workspace migration.
                Check the Apps page warning icon or ask the agent to fix data-sources.json.
              </p>
            </div>
          ) : null}
          {iframeLoadError && !gatewaySupervisorStarting && !runtimeError ? (
            <div className="mini-app-view__overlay mini-app-view__overlay--hint">
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
