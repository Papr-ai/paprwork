import { useMemo, useEffect, useRef } from "react";
import { useApp } from "../../hooks/useApp";
import { trackEvent } from "../../lib/telemetry";
import "./MiniAppView.css";

interface MiniAppViewProps {
  appId: string;
}

export function MiniAppView({ appId }: MiniAppViewProps) {
  const { reloadKey } = useApp(appId);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const src = useMemo(() => {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}/apps/${appId}/index.html`;
  }, [appId]);

  useEffect(() => {
    trackEvent("paprwork_app_opened", { app_id: appId } as Record<string, unknown>);
  }, [appId]);

  // Inject paprAPI BEFORE app scripts execute via inline script tag
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      const iframeDocument = iframe.contentDocument;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDocument || !iframeWindow) return;

      // Inject paprAPI setup script at the BEGINNING of <head>
      // This ensures it's available before any app scripts run
      const paprScript = iframeDocument.createElement('script');
      paprScript.textContent = `
        // paprAPI - Available immediately for mini-app scripts
        window.paprAPI = {
          invoke: function(method, ...args) {
            return new Promise((resolve, reject) => {
              const messageId = 'papr-invoke-' + Date.now() + '-' + Math.random().toString(36).substring(7);
              
              const handler = (event) => {
                if (event.data?.type === 'papr-invoke-response' && event.data.id === messageId) {
                  window.removeEventListener('message', handler);
                  if (event.data.error) {
                    reject(new Error(event.data.error));
                  } else {
                    resolve(event.data.result);
                  }
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
        console.log('[paprAPI] Injected and ready');
      `;
      
      // Insert at the beginning of <head> so it runs first
      const head = iframeDocument.head;
      if (head && head.firstChild) {
        head.insertBefore(paprScript, head.firstChild);
      } else if (head) {
        head.appendChild(paprScript);
      }

      console.log(`[MiniAppView] Injected paprAPI into ${appId}`);
    };

    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [appId, reloadKey]);

  // Listen for papr-invoke-request messages from iframe
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // Only handle papr-invoke-request messages
      if (event.data?.type !== "papr-invoke-request") return;
      
      // Only handle messages from this app's iframe
      if (event.data.appId !== appId) return;

      const { id, method, args } = event.data;

      try {
        // Forward to Electron via electronAPI.system.invoke
        if (!window.electronAPI?.system?.invoke) {
          throw new Error("electronAPI.system.invoke not available");
        }

        const result = await window.electronAPI.system.invoke(method, args);

        // Send response back to iframe
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: "papr-invoke-response",
            id,
            result,
          },
          "*"
        );
      } catch (error) {
        // Send error back to iframe
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: "papr-invoke-response",
            id,
            error: (error as Error).message,
          },
          "*"
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [appId]);

  return (
    <div className="mini-app-view">
      <iframe
        ref={iframeRef}
        key={`${appId}-${reloadKey}`}
        className="mini-app-view__frame"
        src={src}
        title={`mini-app-${appId}`}
        sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="microphone; camera"
      />
    </div>
  );
}
