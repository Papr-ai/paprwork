/**
 * useAppUpdater - Hook for managing app version and updates
 * 
 * Uses a ref-based callback so the listener registered once in useEffect
 * always calls the latest handler without re-subscribing.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { UpdateStatus } from "../types/electron";

interface UseAppUpdaterReturn {
  currentVersion: string;
  updateStatus: UpdateStatus | null;
  checkForUpdates: () => void;
  installUpdate: () => void;
  isChecking: boolean;
  isDownloading: boolean;
  isUpdateReady: boolean;
  hasUpdate: boolean;
}

export function useAppUpdater(): UseAppUpdaterReturn {
  const [currentVersion, setCurrentVersion] = useState<string>("2.0.10");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const callbackRef = useRef<((status: UpdateStatus) => void) | undefined>(undefined);

  // Keep callback ref in sync
  callbackRef.current = (status: UpdateStatus) => {
    setUpdateStatus(status);
    if (status.status === "not-available") {
      const metaVersion = document.querySelector('meta[name="app-version"]')?.getAttribute('content');
      if (metaVersion) setCurrentVersion(metaVersion);
    }
  };

  useEffect(() => {
    const updaterAPI = window.electronAPI?.updater;
    if (!updaterAPI) {
      setUpdateStatus({ status: "error", error: "Updater not available" });
      return;
    }

    // Stable handler that delegates to ref
    const handler = (status: UpdateStatus) => {
      callbackRef.current?.(status);
    };

    updaterAPI.onStatus(handler);

    // Read version from meta tag
    const metaVersion = document.querySelector('meta[name="app-version"]')?.getAttribute('content');
    if (metaVersion) setCurrentVersion(metaVersion);

    return () => {
      updaterAPI.removeStatusListener(handler);
    };
  }, []);

  const checkForUpdates = useCallback(() => {
    const updater = window.electronAPI?.updater;
    if (!updater) {
      setUpdateStatus({ status: "error", error: "Updater not available. Please restart the app." });
      return;
    }
    updater.check();
  }, []);

  const installUpdate = useCallback(() => {
    window.electronAPI?.updater?.install();
  }, []);

  const isChecking = updateStatus?.status === "checking";
  const isDownloading = updateStatus?.status === "downloading";
  const isUpdateReady = updateStatus?.status === "ready";
  const hasUpdate = updateStatus?.status === "available" || isDownloading || isUpdateReady;

  return {
    currentVersion,
    updateStatus,
    checkForUpdates,
    installUpdate,
    isChecking,
    isDownloading,
    isUpdateReady,
    hasUpdate,
  };
}
