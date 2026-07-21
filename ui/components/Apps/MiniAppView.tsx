import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { useApp } from "../../hooks/useApp";
import { useCloudPublish } from "../../hooks/useCloudPublish";
import { useGatewaySupervisorStatus } from "../../hooks/useGatewaySupervisorStatus";
import { trackEvent } from "../../lib/telemetry";
import { gateway } from "../../src/lib/gateway";
import type { ArtifactCloudLineage } from "../../stores/artifactsStore";
import {
  MiniAppPublishBar,
  type AppPreviewMode,
} from "./MiniAppPublishBar";
import { MiniAppFilesView } from "./MiniAppFilesView";
import type { AppWorkspaceMode } from "../../hooks/useAppWorkspace";
import "./MiniAppPublishBar.css";

interface MiniAppViewProps {
  appId: string;
}

export function MiniAppView({ appId }: MiniAppViewProps) {
  const { reloadKey, triggerReload } = useApp(appId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [appTitle, setAppTitle] = useState("Mini-app");
  const [cloudLineage, setCloudLineage] = useState<ArtifactCloudLineage | null>(null);
  const [viewMode, setViewMode] = useState<AppPreviewMode>("local");
  const [workspaceMode, setWorkspaceMode] = useState<AppWorkspaceMode>("preview");
  const [iframeLoadKey, setIframeLoadKey] = useState(0);
  const [iframeLoadError, setIframeLoadError] = useState<string | null>(null);
  const iframeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloud = useCloudPublish(appId, appTitle);
  const { isReady: gatewaySupervisorReady, isStarting: gatewaySupervisorStarting, status: gatewaySupervisorStatus } =
    useGatewaySupervisorStatus();
  const prevGatewaySupervisorReadyRef = useRef(gatewaySupervisorReady);

  const localSrc = useMemo(() => {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}/apps/${appId}/index.html`;
  }, [appId]);

  const isPublishedPreview =
    viewMode === "published" && cloud.live && !!cloud.publishedPreviewUrl;

  const iframeSrc = useMemo(() => {
    if (isPublishedPreview) {
      return cloud.publishedPreviewUrl!;
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
    cloud.publishedPreviewUrl,
  ]);

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
    void (async () => {
      try {
        const resp = await gateway.send("app:get", { appId });
        const data = resp.data as {
          title?: string;
          cloudLineage?: ArtifactCloudLineage;
        };
        const title = data?.title?.trim();
        if (title) setAppTitle(title);
        setCloudLineage(data?.cloudLineage ?? null);
      } catch {
        /* optional */
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
    if (!cloud.live && viewMode === "published") {
      setViewMode("local");
    }
  }, [cloud.live, viewMode]);

  useEffect(() => {
    trackEvent("paprwork_app_opened", { app_id: appId } as Record<string, unknown>);
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
  }, [appId]);

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

  return (
    <div className="mini-app-view">
      <MiniAppPublishBar
        appId={appId}
        appTitle={appTitle}
        cloud={cloud}
        cloudLineage={cloudLineage}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        workspaceMode={workspaceMode}
        onWorkspaceModeChange={setWorkspaceMode}
        onTrackPullComplete={() => void refreshAppMetadata()}
      />
      {workspaceMode === "files" ? (
        <MiniAppFilesView appId={appId} />
      ) : (
        <div className="mini-app-view__frame-wrap">
          {gatewaySupervisorStarting && !isPublishedPreview ? (
            <div className="mini-app-view__overlay">
              <p>Gateway is starting — app preview will load when ready…</p>
            </div>
          ) : null}
          {shouldLoadLocalIframe || isPublishedPreview ? (
            <iframe
              ref={iframeRef}
              key={`${appId}-${viewMode}-${isPublishedPreview ? cloud.publishedPreviewUrl : reloadKey}-${iframeLoadKey}`}
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
              }}
              onError={() => {
                if (!isPublishedPreview) {
                  scheduleIframeRetry("Could not load app preview — retrying…");
                }
              }}
            />
          ) : null}
          {iframeLoadError && !gatewaySupervisorStarting ? (
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
