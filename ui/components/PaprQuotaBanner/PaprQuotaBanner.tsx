/**
 * PaprQuotaBanner — compact notice when Papr Memory cloud features are blocked.
 */

import { useEffect, useMemo, useState } from "react";
import type { PaprQuotaKind } from "../../stores/paprQuotaStore";
import { usePaprQuotaStore } from "../../stores/paprQuotaStore";
import { PaprLogoMark } from "../common/PaprLogoMark";
import { openPaprPlanSettings } from "../../utils/cloudMemoryStatus";
import { useBillingSettingsVisible } from "../../hooks/useBillingSettingsVisible";
import { hasActivePaprSubscription } from "../../../src/core/utils/paprPlanLimits";
import "./PaprQuotaBanner.css";

function resolveBannerCopy(input: {
  kind: PaprQuotaKind;
  subscriptionMode: "needs_subscription" | "billing_mismatch" | null;
  canManageBilling: boolean;
}): { title: string; detail: string; primaryLabel: string } {
  const localWorks = "Local chat works.";

  if (input.kind === "subscription") {
    if (input.subscriptionMode === "billing_mismatch") {
      return {
        title: "Cloud sync issue",
        detail: `${localWorks} Sign out and back in to refresh billing.`,
        primaryLabel: "Plan & usage",
      };
    }
    return {
      title: "Subscription cancelled.",
      detail: "Papr Cloud features paused. Local chat works.",
      primaryLabel: "Plan & usage",
    };
  }

  if (
    input.kind === "operations" ||
    input.kind === "memories" ||
    input.kind === "storage"
  ) {
    return {
      title: "Plan limit reached",
      detail: input.canManageBilling
        ? `${localWorks} Upgrade or enable metered billing.`
        : `${localWorks} Ask your workspace owner to upgrade.`,
      primaryLabel: "Plan & usage",
    };
  }

  return {
    title: "Papr Cloud paused",
    detail: `${localWorks} Review Plan & usage in Settings.`,
    primaryLabel: "Plan & usage",
  };
}

export function PaprQuotaBanner() {
  const active = usePaprQuotaStore((state) => state.active);
  const dismiss = usePaprQuotaStore((state) => state.dismiss);
  const billingSettingsVisible = useBillingSettingsVisible();
  const [subscriptionMode, setSubscriptionMode] = useState<
    "needs_subscription" | "billing_mismatch" | null
  >(null);
  const [canManageBilling, setCanManageBilling] = useState(false);

  useEffect(() => {
    if (!active || active.kind !== "subscription") {
      setSubscriptionMode(null);
      setCanManageBilling(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const result = await window.electronAPI.papr.getPlanSummary();
        if (cancelled) return;

        if (result.success && result.summary) {
          setCanManageBilling(result.summary.canManageBilling);
          setSubscriptionMode(
            hasActivePaprSubscription(result.summary)
              ? "billing_mismatch"
              : "needs_subscription",
          );
          return;
        }
      } catch (error) {
        console.warn("[PaprQuotaBanner] Failed to load plan summary:", error);
      }

      if (!cancelled) {
        setSubscriptionMode("needs_subscription");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active]);

  const copy = useMemo(() => {
    if (!active) return null;
    return resolveBannerCopy({
      kind: active.kind,
      subscriptionMode,
      canManageBilling,
    });
  }, [active, subscriptionMode, canManageBilling]);

  if (!active || !copy || billingSettingsVisible) return null;

  const handleOpenBilling = () => {
    openPaprPlanSettings();
    dismiss(active);
  };

  return (
    <div
      className="papr-quota-banner"
      data-severity={active.severity}
      role="alert"
    >
      <PaprLogoMark size={14} className="papr-quota-banner__mark" />
      <div className="papr-quota-banner__content">
        <div className="papr-quota-banner__text-block">
          <span className="papr-quota-banner__title">{copy.title}</span>
          <span className="papr-quota-banner__detail">{copy.detail}</span>
        </div>
        <div className="papr-quota-banner__actions">
          <button
            type="button"
            className="papr-quota-banner__action"
            onClick={handleOpenBilling}
          >
            {copy.primaryLabel}
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
