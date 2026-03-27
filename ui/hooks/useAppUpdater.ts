/**
 * useAppUpdater - Hook for managing app version and updates
 */

import { useState, useEffect, useCallback } from "react";
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

  useEffect(() => {
    const updaterAPI = window.electronAPI?.updater;
    if (!updaterAPI) {
      return;
    }

    const handleStatusUpdate = (status: UpdateStatus) => {
      setUpdateStatus(status);
      
      // Extract current version from update status if available
      // When "not-available" is returned, we know the current version is latest
      if (status.status === "not-available" && !status.version) {
        // Read from package.json version in meta tag
        const metaVersion = document.querySelector('meta[name="app-version"]')?.getAttribute('content');
        if (metaVersion) {
          setCurrentVersion(metaVersion);
        }
      }
    };

    updaterAPI.onStatus(handleStatusUpdate);

    // Try to read version from meta tag
    const metaVersion = document.querySelector('meta[name="app-version"]')?.getAttribute('content');
    if (metaVersion) {
      setCurrentVersion(metaVersion);
    }

    return () => {
      updaterAPI.removeStatusListener();
    };
  }, []);

  const checkForUpdates = useCallback(() => {
    window.electronAPI?.updater?.check();
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
