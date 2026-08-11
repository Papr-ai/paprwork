/**
 * PaprQuotaBanner — global plan-limit notice when Papr Memory ops/memories are exceeded.
 * Matches UpdateBanner liquid-glass styling; stacks above it when both are visible.
 */

import { useEffect, useState } from "react";
import { hasActivePaprSubscription } from "../../../src/core/utils/paprPlanLimits";
import { usePaprQuotaStore } from "../../stores/paprQuotaStore";
import "./PaprQuotaBanner.css";

type SubscriptionDisplayMode = "needs_subscription" | "billing_mismatch" | null;

function resolveSubscriptionDisplay(
  mode: SubscriptionDisplayMode,
  fallbackTitle: string,
  fallbackDetail: string,
): { title: string; detail: string; hint: string | null } {
  if (mode === "billing_mismatch") {
    return {
      title: "Papr Memory sync issue",
      detail:
        "Settings shows an active subscription, but Papr Memory couldn't verify it for this workspace. Cloud sync and memory may be paused.",
      hint:
        "Try signing out and back in to refresh your API key. If the problem continues, contact Papr support — your billing is active but memory access isn't linked.",
    };
  }

  if (mode === "needs_subscription") {
    return {
      title: fallbackTitle,
      detail: fallbackDetail,
      hint:
        "Check Plan & usage in Settings. If your plan looks correct, sign out and back in to refresh your API key. Otherwise start or renew your plan in Papr.",
    };
  }

  return { title: fallbackTitle, detail: fallbackDetail, hint: null };
}

export function PaprQuotaBanner() {
  const active = usePaprQuotaStore((state) => state.active);
  const dismiss = usePaprQuotaStore((state) => state.dismiss);
  const [subscriptionDisplayMode, setSubscriptionDisplayMode] =
    useState<SubscriptionDisplayMode>(null);

  useEffect(() => {
    if (!active || active.kind !== "subscription") {
      setSubscriptionDisplayMode(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const result = await window.electronAPI.papr.getPlanSummary();
        if (cancelled) return;

        if (result.success && result.summary) {
          setSubscriptionDisplayMode(
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
        setSubscriptionDisplayMode("needs_subscription");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active]);

  if (!active) return null;

  const subscriptionCopy =
    active.kind === "subscription"
      ? resolveSubscriptionDisplay(
          subscriptionDisplayMode,
          active.title,
          active.detail,
        )
      : null;

  const title = subscriptionCopy?.title ?? active.title;
  const detail = subscriptionCopy?.detail ?? active.detail;

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
            <span className="papr-quota-banner__title">{title}</span>
            <span className="papr-quota-banner__detail">{detail}</span>
            {subscriptionCopy?.hint ? (
              <span className="papr-quota-banner__hint">{subscriptionCopy.hint}</span>
            ) : active.suggestMeteredBilling ? (
              <span className="papr-quota-banner__hint">
                Upgrade your plan or add a payment method and enable metered
                billing in Papr.
              </span>
            ) : null}
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
