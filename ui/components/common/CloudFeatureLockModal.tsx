import React from "react";
import { PaprLogoMark } from "./PaprLogoMark";
import { usePaprCloudFeatureStore } from "../../stores/paprCloudFeatureStore";
import {
  openCloudSyncSettings,
  openPaprLoginSettings,
  openPaprPlanSettings,
} from "../../utils/paprCloudFeatureUi";
import "./CloudFeatureLockModal.css";

export function CloudFeatureLockModal(): React.ReactElement | null {
  const lockModal = usePaprCloudFeatureStore((state) => state.lockModal);
  const clearLockModal = usePaprCloudFeatureStore((state) => state.clearLockModal);

  if (!lockModal) {
    return null;
  }

  const handlePrimary = (): void => {
    switch (lockModal.lockAction) {
      case "open_login":
        openPaprLoginSettings();
        break;
      case "open_plan":
        openPaprPlanSettings();
        break;
      case "enable_cloud_sync":
        openCloudSyncSettings();
        break;
      default:
        openPaprPlanSettings();
        break;
    }
    clearLockModal();
  };

  const primaryLabel =
    lockModal.lockAction === "open_login"
      ? "Sign in to Papr"
      : lockModal.lockAction === "enable_cloud_sync"
        ? "Open Cloud Sync settings"
        : "View plans";

  return (
    <div
      className="cloud-feature-lock__backdrop"
      role="presentation"
      onClick={clearLockModal}
    >
      <div
        className="cloud-feature-lock"
        role="dialog"
        aria-labelledby="cloud-feature-lock-title"
        aria-describedby="cloud-feature-lock-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="cloud-feature-lock__header">
          <PaprLogoMark size={16} />
          <h2 id="cloud-feature-lock-title" className="cloud-feature-lock__title">
            {lockModal.title}
          </h2>
        </div>
        <p id="cloud-feature-lock-desc" className="cloud-feature-lock__message">
          {lockModal.message}
        </p>
        {lockModal.localFallback ? (
          <p className="cloud-feature-lock__fallback">{lockModal.localFallback}</p>
        ) : null}
        <div className="cloud-feature-lock__actions">
          <button
            type="button"
            className="cloud-feature-lock__primary"
            onClick={handlePrimary}
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            className="cloud-feature-lock__secondary"
            onClick={clearLockModal}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
