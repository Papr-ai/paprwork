/**
 * PaprQuotaBanner — global plan-limit notice when Papr Memory ops/memories are exceeded.
 * Matches UpdateBanner liquid-glass styling; stacks above it when both are visible.
 */

import { usePaprQuotaStore } from "../../stores/paprQuotaStore";
import "./PaprQuotaBanner.css";

export function PaprQuotaBanner() {
  const active = usePaprQuotaStore((state) => state.active);
  const dismiss = usePaprQuotaStore((state) => state.dismiss);

  if (!active) return null;

  const openPlanSettings = () => {
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", {
        detail: { tab: "models" },
      }),
    );
    window.dispatchEvent(new CustomEvent("papr:focus-plan-section"));
  };

  const openUsageDashboard = async () => {
    try {
      await window.electronAPI.papr.openUsageDashboard();
    } catch (error) {
      console.error("[PaprQuotaBanner] Failed to open usage dashboard:", error);
    }
  };

  return (
    <div
      className="papr-quota-banner"
      data-severity={active.severity}
      role="alert"
    >
      <div className="papr-quota-banner__content">
        <div className="papr-quota-banner__header">
          <span className="papr-quota-banner__icon" aria-hidden>
            {active.severity === "warning" ? "!" : "⚠"}
          </span>
          <div className="papr-quota-banner__text-block">
            <span className="papr-quota-banner__title">{active.title}</span>
            <span className="papr-quota-banner__detail">{active.detail}</span>
            {active.suggestMeteredBilling && (
              <span className="papr-quota-banner__hint">
                Upgrade your plan or add a payment method and enable metered
                billing in Papr.
              </span>
            )}
          </div>
        </div>
        <div className="papr-quota-banner__actions">
          <button
            type="button"
            className="papr-quota-banner__action"
            onClick={openPlanSettings}
          >
            Manage plan
          </button>
          <button
            type="button"
            className="papr-quota-banner__secondary"
            onClick={() => void openUsageDashboard()}
          >
            Usage dashboard
          </button>
        </div>
      </div>
      <button
        type="button"
        className="papr-quota-banner__dismiss"
        onClick={() => dismiss(active)}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
