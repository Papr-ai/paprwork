/**
 * Live cloud app preview (Team / Community catalog) in a desktop iframe tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import type { CloudCatalogPreviewTabMetadata } from "../../types/cloudCatalogPreviewTab";
import { canInstallCloudCatalogEntry } from "../../utils/communityAppLocalOpen";
import { fetchCatalogEntryById } from "../../utils/fetchCatalogEntry";
import { useCloudCatalogInstallFlow } from "../../hooks/useCloudCatalogInstallFlow";
import { ImportSetupWizard } from "./ImportSetupWizard";
import { CloudCatalogInstallModal } from "./CloudCatalogInstallModal";
import { MiniAppPreviewUrlBar } from "./MiniAppPreviewUrlBar";
import "./MiniAppPublishBar.css";
import "./CloudCatalogPreviewView.css";

interface CloudCatalogPreviewViewProps {
  title: string;
  preview: CloudCatalogPreviewTabMetadata;
}

type PreviewPhase = "loading" | "starting" | "ready" | "error";

const SLOW_LOAD_MS = 3500;
const STARTING_POLL_MS = 200;
const STARTING_MAX_POLLS = 40;

function readIframePreviewText(iframe: HTMLIFrameElement | null): string {
  try {
    return iframe?.contentDocument?.body?.innerText?.trim() ?? "";
  } catch {
    return "";
  }
}

export function CloudCatalogPreviewView({
  title,
  preview,
}: CloudCatalogPreviewViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeLoadKey, setIframeLoadKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [slowLoad, setSlowLoad] = useState(false);
  const [linkToast, setLinkToast] = useState<string | null>(null);
  const [catalogEntry, setCatalogEntry] = useState<CommunityCatalogEntry | null>(
    null,
  );

  const {
    installModeEntry,
    setInstallModeEntry,
    installingId,
    installToast,
    cloudInstallWizard,
    installCloudApp,
    startCloudInstall,
    resolveLocalAppId,
    finishInstallWizard,
    openInstallHelp,
  } = useCloudCatalogInstallFlow();

  useEffect(() => {
    let cancelled = false;
    void fetchCatalogEntryById(preview.catalogId)
      .then((entry) => {
        if (!cancelled) {
          setCatalogEntry(entry);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogEntry(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [preview.catalogId]);

  const showCustomize = useMemo(() => {
    if (!catalogEntry) return false;
    const localAppId = resolveLocalAppId(catalogEntry);
    return canInstallCloudCatalogEntry(catalogEntry, localAppId);
  }, [catalogEntry, resolveLocalAppId]);

  const isInstalling =
    catalogEntry !== null && installingId === catalogEntry.catalogId;

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

  useEffect(() => {
    setPhase("loading");
    setLoadError(null);
    setSlowLoad(false);

    const slowTimer = window.setTimeout(() => {
      setSlowLoad(true);
    }, SLOW_LOAD_MS);

    return () => window.clearTimeout(slowTimer);
  }, [iframeSrc]);

  const markReady = useCallback(() => {
    setPhase("ready");
    setLoadError(null);
    setSlowLoad(false);
  }, []);

  const handleIframeLoad = useCallback(() => {
    setPhase("starting");

    let polls = 0;
    const pollForContent = (): void => {
      polls += 1;
      const text = readIframePreviewText(iframeRef.current);

      if (
        text.includes("Access validate failed") ||
        text.includes("Forbidden") ||
        text.includes("Sign in to Papr")
      ) {
        setPhase("error");
        setLoadError(
          text.includes("Access validate failed")
            ? "Could not verify access to this app. Try Refresh or sign in to Papr in Settings."
            : text.slice(0, 240) ||
                "Could not load live preview — try Refresh or Open in browser.",
        );
        return;
      }

      if (text.length > 40) {
        markReady();
        return;
      }

      if (polls >= STARTING_MAX_POLLS) {
        markReady();
        return;
      }

      window.setTimeout(pollForContent, STARTING_POLL_MS);
    };

    window.setTimeout(pollForContent, STARTING_POLL_MS);
  }, [markReady]);

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

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(preview.liveUrl);
      setLinkToast("Link copied");
      window.setTimeout(() => setLinkToast(null), 2000);
    } catch {
      setLinkToast("Could not copy link");
      window.setTimeout(() => setLinkToast(null), 2500);
    }
  }, [preview.liveUrl]);

  const refreshPreview = useCallback(() => {
    setLoadError(null);
    setPhase("loading");
    setSlowLoad(false);
    setIframeLoadKey((key) => key + 1);
  }, []);

  const handleCustomize = useCallback(() => {
    if (!catalogEntry) return;
    startCloudInstall(catalogEntry);
  }, [catalogEntry, startCloudInstall]);

  const showOverlay = phase !== "ready";
  const statusLabel =
    showOverlay && !loadError ? "Loading…" : "Live · preview";
  const barToast = installToast ?? linkToast;
  const loadingMessage =
    phase === "starting" ? "Starting app…" : "Loading live preview…";
  const loadingHint =
    phase === "loading" && slowLoad
      ? "Cloud apps can take a moment on first open — fetching from apps.papr.ai."
      : phase === "starting"
        ? "Connecting to shared data and verifying team access."
        : null;

  return (
    <div className="mini-app-view">
      <MiniAppPreviewUrlBar
        title={title}
        statusLabel={statusLabel}
        displayUrl={preview.liveUrl}
        onRefresh={refreshPreview}
        refreshDisabled={phase === "loading"}
        refreshTitle="Refresh web preview"
        onOpenInBrowser={() => void openInBrowser()}
        onCopyLink={() => void copyLink()}
        primaryAction={
          showCustomize
            ? {
                label: isInstalling ? "Installing…" : "Customize",
                onClick: handleCustomize,
                disabled: isInstalling,
              }
            : undefined
        }
        toast={barToast}
      />
      <div className="mini-app-view__frame-wrap">
        <iframe
          ref={iframeRef}
          key={iframeSrc}
          className="mini-app-view__frame"
          src={iframeSrc}
          title={title}
          sandbox="allow-scripts allow-forms allow-modals allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allow="microphone; camera"
          onLoad={handleIframeLoad}
          onError={() => {
            setPhase("error");
            setLoadError(
              "Could not load live preview — try Refresh or Open in browser.",
            );
          }}
        />
        {loadError ? (
          <div className="mini-app-view__overlay mini-app-view__overlay--hint cloud-catalog-preview__overlay">
            <p>{loadError}</p>
            <button
              type="button"
              className="mini-app-publish-bar__button"
              onClick={refreshPreview}
            >
              Retry
            </button>
          </div>
        ) : showOverlay ? (
          <div className="mini-app-view__overlay cloud-catalog-preview__overlay">
            <div className="cloud-catalog-preview__loading">
              <div className="cloud-catalog-preview__spinner" aria-hidden="true" />
              <p className="cloud-catalog-preview__loading-title">
                {loadingMessage}
              </p>
              {loadingHint ? (
                <p className="cloud-catalog-preview__loading-hint">
                  {loadingHint}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {installModeEntry ? (
        <CloudCatalogInstallModal
          entry={installModeEntry}
          installing={installingId === installModeEntry.catalogId}
          onClose={() => setInstallModeEntry(null)}
          onSelectMode={(mode) => {
            const target = installModeEntry;
            setInstallModeEntry(null);
            void installCloudApp(target, mode);
          }}
        />
      ) : null}

      {cloudInstallWizard ? (
        <ImportSetupWizard
          appName={cloudInstallWizard.appTitle}
          requirements={cloudInstallWizard.requirements}
          onComplete={finishInstallWizard}
          onCancel={finishInstallWizard}
          onRequestHelp={(req) => void openInstallHelp(req)}
        />
      ) : null}
    </div>
  );
}
