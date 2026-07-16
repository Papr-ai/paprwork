import { useMemo, useEffect, useRef, useState } from "react";
import { useApp } from "../../hooks/useApp";
import { useCloudPublish } from "../../hooks/useCloudPublish";
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
  const cloud = useCloudPublish(appId, appTitle);

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
    return url.toString();
  }, [localSrc, reloadKey, isPublishedPreview, cloud.publishedPreviewUrl]);

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

  // Inject paprAPI for local preview only (cloud iframe has no desktop APIs)
  useEffect(() => {
    if (isPublishedPreview) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      const iframeDocument = iframe.contentDocument;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDocument || !iframeWindow) return;

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
        head.insertBefore(paprScript, head.firstChild);
      } else if (head) {
        head.appendChild(paprScript);
      }
    };

    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [appId, reloadKey, isPublishedPreview]);

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
          <iframe
            ref={iframeRef}
            key={`${appId}-${viewMode}-${isPublishedPreview ? cloud.publishedPreviewUrl : reloadKey}`}
            className="mini-app-view__frame"
            src={iframeSrc}
            title={`mini-app-${appId}`}
            sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            allow="microphone; camera"
          />
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
