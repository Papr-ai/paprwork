/**
 * Live cloud app preview (Team / Community catalog) in a desktop iframe tab.
 */

import { useCallback, useMemo, useState } from "react";
import type { CloudCatalogPreviewTabMetadata } from "../../types/cloudCatalogPreviewTab";
import "./MiniAppPublishBar.css";
import "./CloudCatalogPreviewView.css";

interface CloudCatalogPreviewViewProps {
  title: string;
  preview: CloudCatalogPreviewTabMetadata;
}

export function CloudCatalogPreviewView({
  title,
  preview,
}: CloudCatalogPreviewViewProps) {
  const [iframeLoadKey, setIframeLoadKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const iframeSrc = useMemo(() => {
    try {
      const url = new URL(preview.previewIframeUrl);
      url.searchParams.set("_r", String(iframeLoadKey));
      return url.toString();
    } catch {
      const separator = preview.previewIframeUrl.includes("?") ? "&" : "?";
      return `${preview.previewIframeUrl}${separator}_r=${iframeLoadKey}`;
    }
  }, [preview.previewIframeUrl, iframeLoadKey]);

  const openInBrowser = useCallback(async () => {
    try {
      if (window.electronAPI?.system?.invoke) {
        await window.electronAPI.system.invoke(
          "shell.openExternal",
          preview.liveUrl,
        );
      } else {
        window.open(preview.liveUrl, "_blank", "noopener,noreferrer");
      }
    } catch {
      /* ignore */
    }
  }, [preview.liveUrl]);

  const refreshPreview = useCallback(() => {
    setLoadError(null);
    setIframeLoadKey((key) => key + 1);
  }, []);

  return (
    <div className="mini-app-view">
      <div className="cloud-catalog-preview-bar">
        <span className="cloud-catalog-preview-bar__title">{title}</span>
        <span className="cloud-catalog-preview-bar__badge">Live preview</span>
        <div className="cloud-catalog-preview-bar__actions">
          <button
            type="button"
            className="cloud-catalog-preview-bar__btn"
            onClick={refreshPreview}
          >
            Refresh
          </button>
          <button
            type="button"
            className="cloud-catalog-preview-bar__btn"
            onClick={() => void openInBrowser()}
          >
            Open in browser
          </button>
        </div>
      </div>
      <div className="mini-app-view__frame-wrap">
        <iframe
          key={iframeSrc}
          className="mini-app-view__frame"
          src={iframeSrc}
          title={title}
          sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allow="microphone; camera"
          onLoad={() => setLoadError(null)}
          onError={() =>
            setLoadError("Could not load live preview — try Refresh or Open in browser.")
          }
        />
        {loadError ? (
          <div className="mini-app-view__overlay mini-app-view__overlay--hint">
            <p>{loadError}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
