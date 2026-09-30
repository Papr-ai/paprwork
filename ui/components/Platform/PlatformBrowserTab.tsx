/**
 * In-app platform browser tab (LinkedIn inside Papr — not an iframe).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../../utils/copyToClipboard";
import { PlatformBrowserUrlBar } from "./PlatformBrowserUrlBar";
import "./PlatformBrowserTab.css";

const PLATFORM_TAB_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  reddit: "Reddit",
  facebook: "Facebook",
  tiktok: "TikTok",
  twitter: "X / Twitter",
  telegram: "Telegram",
};

export const PLATFORM_TAB_ICON: Record<string, string> = {
  linkedin:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 114.127 0 2.063 2.063 0 01-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
};

interface PlatformBrowserTabProps {
  platformId: string;
  isActive: boolean;
}

function isDisplayableUrl(url: string): boolean {
  return url.length > 0 && url !== "about:blank";
}

/** OAuth hosts where platform passkeys (Touch ID) don't work in Electron yet. */
function isOAuthPasskeyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "accounts.google.com" ||
      host === "appleid.apple.com" ||
      host === "login.microsoftonline.com"
    );
  } catch {
    return false;
  }
}

export function PlatformBrowserTab({
  platformId,
  isActive,
}: PlatformBrowserTabProps) {
  const platformLabel = PLATFORM_TAB_LABELS[platformId] ?? platformId;
  const viewRef = useRef<HTMLDivElement>(null);
  const [currentUrl, setCurrentUrl] = useState("");
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [redirectLoop, setRedirectLoop] = useState(false);

  const syncBounds = useCallback(async () => {
    const api = window.electronAPI?.platformBrowser;
    const container = viewRef.current;
    if (!api || !container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    await api.setBounds({
      platformId,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      visible: isActive && rect.width > 0 && rect.height > 0,
    });
  }, [platformId, isActive]);

  const refreshUrlState = useCallback(async () => {
    const api = window.electronAPI?.platformBrowser;
    if (!api?.getState) {
      return;
    }
    const result = await api.getState(platformId);
    if (result.success && result.data?.url) {
      setCurrentUrl(result.data.url);
    }
  }, [platformId]);

  useEffect(() => {
    void syncBounds();
  }, [syncBounds]);

  useEffect(() => {
    void refreshUrlState();
  }, [refreshUrlState, isActive]);

  useEffect(() => {
    const api = window.electronAPI?.platformBrowser;
    if (!api?.onUrlChanged) {
      return;
    }
    return api.onUrlChanged((data) => {
      if (data.platformId !== platformId) {
        return;
      }
      setCurrentUrl(data.url);
    });
  }, [platformId]);

  useEffect(() => {
    const api = window.electronAPI?.platformBrowser;
    if (!api?.onRedirectLoop) {
      return;
    }
    return api.onRedirectLoop((data) => {
      if (data.platformId !== platformId) {
        return;
      }
      setRedirectLoop(true);
    });
  }, [platformId]);

  useEffect(() => {
    if (!copyToast) {
      return;
    }
    const timer = window.setTimeout(() => setCopyToast(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyToast]);

  useEffect(() => {
    const container = viewRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      void syncBounds();
    });
    observer.observe(container);

    const onWindowChange = () => {
      void syncBounds();
    };
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onWindowChange, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onWindowChange, true);
      void window.electronAPI?.platformBrowser?.setBounds({
        platformId,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
    };
  }, [platformId, syncBounds]);

  const handleRefresh = useCallback(() => {
    setRedirectLoop(false);
    void window.electronAPI?.platformBrowser?.reload?.(platformId);
  }, [platformId]);

  const handleOpenInBrowser = useCallback(() => {
    if (!isDisplayableUrl(currentUrl)) {
      return;
    }
    void window.electronAPI?.system.invoke("shell.openExternal", currentUrl);
  }, [currentUrl]);

  const handleCopyLink = useCallback(async () => {
    if (!isDisplayableUrl(currentUrl)) {
      return;
    }
    const copied = await copyTextToClipboard(currentUrl);
    setCopyToast(copied ? "Link copied" : "Could not copy");
  }, [currentUrl]);

  return (
    <div className="platform-browser-tab">
      <PlatformBrowserUrlBar
        platformLabel={platformLabel}
        displayUrl={currentUrl}
        copyToast={copyToast}
        onRefresh={handleRefresh}
        onOpenInBrowser={handleOpenInBrowser}
        onCopyLink={() => void handleCopyLink()}
      />
      {redirectLoop ? (
        <div className="platform-browser-tab__redirect-loop" role="alert">
          LinkedIn keeps reloading — usually a stale session in Papr&apos;s embedded browser.
          Go to <strong>Settings → Platform Connections</strong>, disconnect LinkedIn, connect
          again, and sign in. Or use the refresh button after reconnecting.
        </div>
      ) : null}
      {isActive && isOAuthPasskeyHost(currentUrl) ? (
        <div className="platform-browser-tab__passkey-tip" role="status">
          Touch ID / passkey prompts do not appear in Papr&apos;s embedded browser (Electron
          limitation). On the sign-in page, click <strong>Try another way</strong> and use
          password, SMS, or an authenticator code instead.
        </div>
      ) : null}
      <div className="platform-browser-tab__view" ref={viewRef}>
        {!isActive ? (
          <div className="platform-browser-tab__placeholder">
            {platformLabel} tab is open — select this tab to view.
          </div>
        ) : null}
      </div>
    </div>
  );
};
