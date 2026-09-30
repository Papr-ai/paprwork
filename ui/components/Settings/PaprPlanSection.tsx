/**
 * Plan & usage section inside Papr account settings.
 */

import { useCallback, useEffect, useState } from "react";
import type { PaprPlanSummary } from "../../../src/core/types/paprBilling";
import {
  formatStorageUsage,
  formatSubscriptionStatusLabel,
  hasActivePaprSubscription,
  planDisplayName,
  planFeaturesForTier,
  requiresPaymentMethodForMeteredBilling,
  storageLimitToBytes,
  subscriptionStatusTone,
  usageBarPercent,
} from "../../../src/core/utils/paprPlanLimits";
import { planNeedsAttention } from "../../utils/cloudMemoryStatus";
import { refreshPaprBillingStatus } from "../../utils/refreshPaprBillingStatus";
import { useSettingsNavigationStore } from "../../stores/settingsNavigationStore";
import "./PaprPlanSection.css";

const PLAN_OPTIONS = [
  { tier: "developer" as const, price: "Free", isDeveloper: true },
  { tier: "starter" as const, price: "$100/mo", isDeveloper: false },
  { tier: "growth" as const, price: "$500/mo", isDeveloper: false },
] as const;

function Spinner() {
  return (
    <svg className="papr-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function UsageMeter({
  label,
  valueLabel,
  percent,
  tone,
}: {
  label: string;
  valueLabel: string;
  percent: number;
  tone: "normal" | "warning" | "exceeded";
}) {
  return (
    <div className="papr-plan__meter">
      <div className="papr-plan__meter-head">
        <span className="papr-plan__meter-label">{label}</span>
        <span className="papr-plan__meter-value">{valueLabel}</span>
      </div>
      <div className="papr-plan__meter-track">
        <div
          className="papr-plan__meter-fill"
          data-tone={tone}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function meterTone(
  exceeded: boolean,
  near: boolean,
): "normal" | "warning" | "exceeded" {
  if (exceeded) return "exceeded";
  if (near) return "warning";
  return "normal";
}

function isOverLimit(current: number, limit: number): boolean {
  return limit > 0 && current >= limit;
}

function subscriptionInactiveMessage(summary: PaprPlanSummary): string | null {
  if (hasActivePaprSubscription(summary)) {
    return null;
  }

  const status = summary.subscriptionStatus?.trim().toLowerCase();
  if (status === "canceled") {
    return "Subscription canceled. Papr Cloud paused. Local chat still works.";
  }
  if (status === "past_due" || status === "unpaid") {
    return summary.canManageBilling
      ? "Payment is past due. Update billing to restore Papr Cloud."
      : "Payment is past due. Papr Cloud paused. Local chat still works.";
  }
  return summary.canManageBilling
    ? "No active subscription. Subscribe to restore Papr Cloud."
    : "No active subscription. Papr Cloud paused. Local chat still works.";
}

function meterToneForSummary(
  summary: PaprPlanSummary,
  exceeded: boolean,
  near: boolean,
  rawOverLimit: boolean,
): "normal" | "warning" | "exceeded" {
  if (summary.isMeteredBillingOn && rawOverLimit) {
    return "warning";
  }
  return meterTone(exceeded, near);
}

function shouldShowUpgradeOptions(summary: PaprPlanSummary): boolean {
  return (
    summary.planTier === "developer" ||
    !hasActivePaprSubscription(summary) ||
    planNeedsAttention(summary)
  );
}

export function PaprPlanSection() {
  const [summary, setSummary] = useState<PaprPlanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [meteredSaving, setMeteredSaving] = useState(false);
  const [portalOpening, setPortalOpening] = useState(false);
  const [planActionTier, setPlanActionTier] = useState<
    "developer" | "starter" | "growth" | null
  >(null);
  const navigationToken = useSettingsNavigationStore((state) => state.token);
  const pendingPlanFocus = useSettingsNavigationStore(
    (state) => state.pendingPlanFocus,
  );

  const loadSummary = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const refreshed = await refreshPaprBillingStatus({ force });
      if (!refreshed) {
        throw new Error("Failed to load plan details");
      }
      setSummary(refreshed);
    } catch (err) {
      setSummary(null);
      setError(err instanceof Error ? err.message : "Failed to load plan details");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const billingHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ summary?: PaprPlanSummary }>).detail;
      if (detail?.summary) {
        setSummary(detail.summary);
        setError(null);
        setLoading(false);
      }
    };
    window.addEventListener("papr:billing-refreshed", billingHandler);
    return () => {
      window.removeEventListener("papr:billing-refreshed", billingHandler);
    };
  }, []);

  useEffect(() => {
    const focusHandler = () => {
      useSettingsNavigationStore.getState().navigate({
        tab: "billing",
        focusPlan: true,
      });
    };
    const contextHandler = () => {
      void loadSummary(true);
    };
    window.addEventListener("papr:focus-plan-section", focusHandler);
    window.addEventListener("papr-organization-changed", contextHandler);
    window.addEventListener("papr-namespace-changed", contextHandler);
    return () => {
      window.removeEventListener("papr:focus-plan-section", focusHandler);
      window.removeEventListener("papr-organization-changed", contextHandler);
      window.removeEventListener("papr-namespace-changed", contextHandler);
    };
  }, [loadSummary]);

  useEffect(() => {
    if (!summary || hasActivePaprSubscription(summary)) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadSummary(true);
    }, 30_000);
    return () => window.clearInterval(intervalId);
  }, [summary, loadSummary]);

  useEffect(() => {
    if (!pendingPlanFocus) return;
    void loadSummary();
    useSettingsNavigationStore.getState().acknowledgePlanFocus();
    window.requestAnimationFrame(() => {
      document
        .getElementById("papr-billing-section")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [navigationToken, pendingPlanFocus, loadSummary]);

  const handlePortal = async (section?: "billing" | "subscriptions") => {
    setActionMessage(null);
    setPortalOpening(true);
    try {
      const result = await window.electronAPI.papr.openBillingPortal({
        section,
        stripeCustomerId: summary?.stripeCustomerId,
      });
      if (!result.success) {
        setActionMessage(result.error || "Could not open billing portal");
      }
    } finally {
      setPortalOpening(false);
    }
  };

  const handleCheckout = async (tier: "starter" | "growth") => {
    setPlanActionTier(tier);
    setActionMessage(null);
    try {
      const result = await window.electronAPI.papr.startCheckout({
        tier,
        billingCycle: "monthly",
      });
      if (!result.success) {
        setActionMessage(result.error || "Could not start checkout");
      }
    } finally {
      setPlanActionTier(null);
    }
  };

  const handleSubscribeDeveloper = async () => {
    setPlanActionTier("developer");
    setActionMessage(null);
    try {
      const result = await window.electronAPI.papr.subscribeDeveloperPlan();
      if (!result.success) {
        setActionMessage(result.error || "Could not activate Builder plan");
        return;
      }
      await loadSummary(true);
      setActionMessage(
        result.alreadyActive
          ? "Builder plan is already active."
          : "Builder plan activated. Papr Cloud is restored on this workspace.",
      );
    } finally {
      setPlanActionTier(null);
    }
  };

  const handleUsageDashboard = async () => {
    setActionMessage(null);
    const result = await window.electronAPI.papr.openUsageDashboard();
    if (!result.success) {
      setActionMessage(result.error || "Could not open usage dashboard");
    }
  };

  const canEnableMeteredBilling =
    summary?.subscriptionStatus === "active" ||
    summary?.subscriptionStatus === "trialing";

  const meteredNeedsPaymentMethod = summary
    ? requiresPaymentMethodForMeteredBilling(summary)
    : false;

  const handleMeteredToggle = async () => {
    if (!summary) return;
    setMeteredSaving(true);
    setActionMessage(null);
    try {
      const result = await window.electronAPI.papr.setMeteredBilling(
        !summary.isMeteredBillingOn,
      );
      if (!result.success) {
        setActionMessage(result.error || "Could not update metered billing");
        return;
      }
      await loadSummary();
      setActionMessage(
        result.enabled
          ? "Metered billing enabled. Usage beyond plan limits will be billed."
          : "Metered billing disabled.",
      );
    } finally {
      setMeteredSaving(false);
    }
  };

  const inactiveMessage = summary ? subscriptionInactiveMessage(summary) : null;
  const showUpgradeOptions = summary ? shouldShowUpgradeOptions(summary) : false;

  return (
    <div className="papr-plan" id="papr-billing-section">
      <div className="papr-plan__header papr-plan__header--compact">
        <button
          type="button"
          className="papr-plan__refresh"
          onClick={() => void loadSummary(true)}
          disabled={loading}
        >
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </div>

      <div className="papr-plan__body">
        {loading && !summary && (
          <div className="papr-plan__placeholder">Loading plan details…</div>
        )}

        {error && !summary && <div className="papr-plan__error">{error}</div>}

        {summary && (
          <>
            {summary.canManageBilling ? null : (
              <div className="papr-plan__callout" role="status">
                <p className="papr-plan__callout-title">
                  Billing changes require the workspace owner
                </p>
                <p className="papr-plan__callout-body">
                  You can still view usage here. Contact your workspace owner to
                  resubscribe, upgrade, or enable metered billing.
                </p>
              </div>
            )}

            <div className="papr-plan__summary">
              <div>
                <div className="papr-plan__plan-name-row">
                  <div className="papr-plan__plan-name">{summary.planName}</div>
                  {summary.subscriptionStatus ? (
                    <span
                      className="papr-plan__status-pill"
                      data-tone={subscriptionStatusTone(summary.subscriptionStatus)}
                    >
                      {formatSubscriptionStatusLabel(summary.subscriptionStatus)}
                    </span>
                  ) : null}
                </div>
                <div className="papr-plan__plan-features">{summary.planFeatures}</div>
                {summary.trialEnd ? (
                  <div className="papr-plan__plan-meta">
                    Trial ends {new Date(summary.trialEnd).toLocaleDateString()}
                  </div>
                ) : null}
              </div>
              {summary.canManageBilling ? (
                <button
                  type="button"
                  className="papr-plan__primary-btn"
                  onClick={() => void handlePortal()}
                  disabled={portalOpening}
                >
                  {portalOpening ? (
                    <>
                      <Spinner /> Opening…
                    </>
                  ) : (
                    "Manage billing"
                  )}
                </button>
              ) : null}
            </div>

            {summary.isTrialPeriod && (
              <div className="papr-plan__plan-meta">
                Trial active — Builder limits apply until your trial ends.
              </div>
            )}

            {inactiveMessage ? (
              <div className="papr-plan__alert" data-tone="exceeded">
                {inactiveMessage}
                {summary.canManageBilling &&
                !hasActivePaprSubscription(summary) ? (
                  <span> Choose a plan below to restore Papr Cloud.</span>
                ) : null}
              </div>
            ) : null}

            {(summary.warnings.operationsExceeded ||
              summary.warnings.memoriesExceeded ||
              summary.warnings.storageExceeded) && (
              <div className="papr-plan__alert" data-tone="exceeded">
                Plan limit reached. Papr Cloud paused. Local chat still works.
                {summary.canManageBilling
                  ? " Upgrade or enable metered billing."
                  : null}
              </div>
            )}

            {summary.isMeteredBillingOn &&
              !summary.warnings.operationsExceeded &&
              !summary.warnings.memoriesExceeded &&
              !summary.warnings.storageExceeded &&
              (isOverLimit(
                summary.usage.miniInteractionCount,
                summary.limits.miniInteractionLimit,
              ) ||
                isOverLimit(summary.usage.memoriesCount, summary.limits.memoriesLimit) ||
                isOverLimit(
                  summary.usage.storageCount,
                  storageLimitToBytes(summary.limits.storageLimit),
                )) && (
                <div className="papr-plan__alert" data-tone="warning">
                  Over plan limits with metered billing on. Usage continues on this device.
                </div>
              )}

            <UsageMeter
              label="Operations this month"
              valueLabel={`${summary.usage.miniInteractionCount.toLocaleString()} / ${summary.limits.miniInteractionLimit.toLocaleString()}`}
              percent={usageBarPercent(
                summary.usage.miniInteractionCount,
                summary.limits.miniInteractionLimit,
              )}
              tone={meterToneForSummary(
                summary,
                summary.warnings.operationsExceeded,
                summary.warnings.operationsNearLimit,
                isOverLimit(
                  summary.usage.miniInteractionCount,
                  summary.limits.miniInteractionLimit,
                ),
              )}
            />

            <UsageMeter
              label="Memories"
              valueLabel={`${summary.usage.memoriesCount.toLocaleString()} / ${summary.limits.memoriesLimit.toLocaleString()}`}
              percent={usageBarPercent(
                summary.usage.memoriesCount,
                summary.limits.memoriesLimit,
              )}
              tone={meterToneForSummary(
                summary,
                summary.warnings.memoriesExceeded,
                summary.warnings.memoriesNearLimit,
                isOverLimit(summary.usage.memoriesCount, summary.limits.memoriesLimit),
              )}
            />

            <UsageMeter
              label="Storage"
              valueLabel={formatStorageUsage(
                summary.usage.storageCount,
                summary.limits.storageLimit,
              )}
              percent={usageBarPercent(
                summary.usage.storageCount,
                storageLimitToBytes(summary.limits.storageLimit),
              )}
              tone={meterToneForSummary(
                summary,
                summary.warnings.storageExceeded,
                summary.warnings.storageNearLimit,
                isOverLimit(
                  summary.usage.storageCount,
                  storageLimitToBytes(summary.limits.storageLimit),
                ),
              )}
            />

            <button
              type="button"
              className="papr-plan__secondary-btn papr-plan__dashboard-btn"
              onClick={() => void handleUsageDashboard()}
            >
              View usage dashboard
            </button>

            {showUpgradeOptions ? (
              <div className="papr-plan__upgrade-section">
                <div className="papr-plan__upgrade-heading">
                  <span className="papr-plan__upgrade-label">
                    {summary.canManageBilling ? "Upgrade plan" : "Available plans"}
                  </span>
                  {!summary.canManageBilling ? (
                    <span className="papr-plan__upgrade-note">
                      Contact your workspace owner to subscribe
                    </span>
                  ) : null}
                </div>
                <div className="papr-plan__upgrade-grid">
                  {PLAN_OPTIONS.map(({ tier, price, isDeveloper }) => {
                    const isCurrentPlan = summary.planTier === tier;
                    const isActiveCurrent =
                      isCurrentPlan && hasActivePaprSubscription(summary);
                    const canChooseDeveloper =
                      isDeveloper &&
                      summary.canManageBilling &&
                      !isActiveCurrent &&
                      (!hasActivePaprSubscription(summary) || isCurrentPlan);

                    return (
                      <div
                        key={tier}
                        className={
                          isCurrentPlan
                            ? "papr-plan__upgrade-card papr-plan__upgrade-card--current"
                            : "papr-plan__upgrade-card"
                        }
                      >
                        <div className="papr-plan__upgrade-card-head">
                          <div className="papr-plan__upgrade-card-name">
                            {planDisplayName(tier)}
                          </div>
                          {isCurrentPlan && summary.subscriptionStatus ? (
                            <span
                              className="papr-plan__status-pill"
                              data-tone={subscriptionStatusTone(summary.subscriptionStatus)}
                            >
                              {formatSubscriptionStatusLabel(summary.subscriptionStatus)}
                            </span>
                          ) : null}
                        </div>
                        <div className="papr-plan__upgrade-card-price">{price}</div>
                        <div className="papr-plan__upgrade-card-features">
                          {planFeaturesForTier(tier)}
                        </div>
                        {isActiveCurrent ? (
                          <span className="papr-plan__upgrade-card-badge">Current plan</span>
                        ) : canChooseDeveloper ? (
                          <button
                            type="button"
                            className="papr-plan__secondary-btn papr-plan__upgrade-card-btn"
                            disabled={planActionTier !== null}
                            onClick={() => void handleSubscribeDeveloper()}
                          >
                            {planActionTier === "developer" ? (
                              <Spinner />
                            ) : isCurrentPlan ? (
                              "Activate free plan"
                            ) : (
                              "Get started free"
                            )}
                          </button>
                        ) : summary.canManageBilling && !isDeveloper ? (
                          <button
                            type="button"
                            className="papr-plan__secondary-btn papr-plan__upgrade-card-btn"
                            disabled={planActionTier !== null}
                            onClick={() => void handleCheckout(tier)}
                          >
                            {planActionTier === tier ? (
                              <Spinner />
                            ) : isCurrentPlan ? (
                              "Resubscribe"
                            ) : (
                              `Choose ${planDisplayName(tier)}`
                            )}
                          </button>
                        ) : isCurrentPlan ? (
                          <span className="papr-plan__upgrade-card-badge">Your plan</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="papr-plan__metered">
              {meteredNeedsPaymentMethod ? (
                <div className="papr-plan__payment-banner">
                  <p className="papr-plan__payment-banner-text">
                    Add a payment method to enable metered billing on the Builder plan.
                  </p>
                  <button
                    type="button"
                    className="papr-plan__primary-btn papr-plan__payment-banner-btn"
                    onClick={() => void handlePortal("billing")}
                    disabled={portalOpening}
                  >
                    {portalOpening ? (
                      <>
                        <Spinner /> Opening…
                      </>
                    ) : (
                      "Add payment method"
                    )}
                  </button>
                </div>
              ) : null}

              <div className="papr-plan__metered-row">
              <div>
                <div className="papr-plan__metered-title">Metered billing</div>
                <div className="papr-plan__metered-copy">
                  Continue using Papr Cloud beyond plan limits with pay-as-you-go billing.
                  {!summary.canManageBilling
                    ? " Only the workspace owner can change this setting."
                    : null}
                </div>
              </div>
              <button
                type="button"
                className={`papr-plan__toggle-btn ${summary.isMeteredBillingOn ? "papr-plan__toggle-btn--on" : ""}`}
                onClick={() => void handleMeteredToggle()}
                disabled={
                  !summary.canManageBilling ||
                  meteredSaving ||
                  !summary.subscriptionObjectId ||
                  (!summary.isMeteredBillingOn &&
                    (!canEnableMeteredBilling || meteredNeedsPaymentMethod))
                }
                aria-pressed={summary.isMeteredBillingOn}
                title={
                  !summary.canManageBilling
                    ? "Only the workspace owner can change metered billing"
                    : meteredNeedsPaymentMethod
                      ? "Add a payment method before enabling metered billing"
                      : undefined
                }
              >
                <span className="papr-plan__toggle-knob" />
              </button>
              </div>
            </div>

            {summary.canManageBilling ? (
              <>
                {!canEnableMeteredBilling && !summary.isMeteredBillingOn && (
                  <p className="papr-plan__hint">
                    Subscribe to a paid plan before enabling metered billing.
                  </p>
                )}
              </>
            ) : null}

            {actionMessage && <p className="papr-plan__message">{actionMessage}</p>}
          </>
        )}
      </div>
    </div>
  );
}
