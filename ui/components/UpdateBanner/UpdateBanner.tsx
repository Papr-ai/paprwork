/**
 * UpdateBanner - Shows a non-intrusive banner when an app update is available
 * Auto-hides after download completes, shows "Restart to update" action
 */

import { useEffect, useState, useRef } from "react";
import type { UpdateStatus } from "../../types/electron";
import "./UpdateBanner.css";

type BannerState = "hidden" | "downloading" | "ready";

export function UpdateBanner() {
  const [state, setState] = useState<BannerState>("hidden");
  const [version, setVersion] = useState<string>("");
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const handlerRef = useRef<((data: UpdateStatus) => void) | undefined>(undefined);

  // Keep handler ref in sync
  handlerRef.current = (data: UpdateStatus) => {
    switch (data.status) {
      case "available":
        if (data.version) setVersion(data.version);
        setState("downloading");
        setDismissed(false);
        break;
      case "downloading":
        setState("downloading");
        if (data.percent !== undefined) setPercent(data.percent);
        break;
      case "ready":
        setState("ready");
        if (data.version) setVersion(data.version);
        setPercent(100);
        setDismissed(false);
        break;
      case "error":
      case "not-available":
        setState("hidden");
        break;
    }
  };

  useEffect(() => {
    const api = window.electronAPI?.updater;
    if (!api) return;

    // Stable handler that delegates to ref
    const handler = (data: UpdateStatus) => {
      handlerRef.current?.(data);
    };

    api.onStatus(handler);
    return () => api.removeStatusListener(handler);
  }, []);

  if (state === "hidden" || dismissed) return null;

  const handleInstall = () => {
    window.electronAPI?.updater?.install();
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  return (
    <div className="update-banner" data-state={state}>
      <div className="update-banner__content">
        {state === "downloading" && (
          <>
            <span className="update-banner__icon">↓</span>
            <span className="update-banner__text">
              Downloading update{version ? ` v${version}` : ""}… {percent > 0 && `${percent}%`}
            </span>
            {percent > 0 && (
              <div className="update-banner__progress">
                <div className="update-banner__progress-bar" style={{ width: `${percent}%` }} />
              </div>
            )}
          </>
        )}
        {state === "ready" && (
          <>
            <span className="update-banner__icon">✦</span>
            <span className="update-banner__text">
              Update{version ? ` v${version}` : ""} ready
            </span>
            <button className="update-banner__action" onClick={handleInstall}>
              Restart to update
            </button>
          </>
        )}
      </div>
      <button className="update-banner__dismiss" onClick={handleDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
