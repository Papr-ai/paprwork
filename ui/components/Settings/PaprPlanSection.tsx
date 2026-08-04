/**
 * Plan & usage section inside Papr account settings.
 */

import { useCallback, useEffect, useState } from "react";
import type { PaprPlanSummary } from "../../../src/core/types/paprBilling";
import {
  formatStorageUsage,
  storageLimitToBytes,
  usageBarPercent,
} from "../../../src/core/utils/paprPlanLimits";
import { useProfileStore } from "../../stores/profileStore";
import "./PaprPlanSection.css";

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

export function PaprPlanSection() {
  const [summary, setSummary] = useState<PaprPlanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [meteredSaving, setMeteredSaving] = useState(false);
  const [checkoutTier, setCheckoutTier] = useState<"starter" | "growth" | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.getPlanSummary();
      if (!result.success || !result.summary) {
        throw new Error(result.error || "Failed to load plan details");
      }
      setSummary(result.summary);
      useProfileStore.getState().setProfile({ plan: result.summary.planName });
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
    const focusHandler = () => {
      setIsCollapsed(false);
      void loadSummary();
    };
    const contextHandler = () => {
      void loadSummary();
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

  const handlePortal = async (section?: "billing" | "subscriptions") => {
    setActionMessage(null);
    const result = await window.electronAPI.papr.openBillingPortal(section);
    if (!result.success) {
      setActionMessage(result.error || "Could not open billing portal");
    }
  };

  const handleCheckout = async (tier: "starter" | "growth") => {
    setCheckoutTier(tier);
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
      setCheckoutTier(null);
    }
  };

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

  const anyWarning =
    summary &&
    (summary.warnings.operationsExceeded ||
      summary.warnings.memoriesExceeded ||
      summary.warnings.storageExceeded ||
      summary.warnings.operationsNearLimit ||
      summary.warnings.memoriesNearLimit ||
      summary.warnings.storageNearLimit ||
      (summary.isMeteredBillingOn &&
        (isOverLimit(
          summary.usage.miniInteractionCount,
          summary.limits.miniInteractionLimit,
        ) ||
          isOverLimit(summary.usage.memoriesCount, summary.limits.memoriesLimit) ||
          isOverLimit(
            summary.usage.storageCount,
            storageLimitToBytes(summary.limits.storageLimit),
          ))));

  return (
    <div className="papr-plan">
      <div className="papr-plan__header">
        <button
          type="button"
          className="papr-plan__toggle"
          onClick={() => setIsCollapsed((value) => !value)}
        >
          <svg
            className={`papr-plan__chevron ${!isCollapsed ? "papr-plan__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Plan & usage</span>
          {anyWarning && <span className="papr-plan__badge">!</span>}
        </button>
        <button
          type="button"
          className="papr-plan__refresh"
          onClick={() => void loadSummary()}
          disabled={loading}
        >
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </div>

      {!isCollapsed && (
        <div className="papr-plan__body">
          {loading && !summary && (
            <div className="papr-plan__placeholder">Loading plan details…</div>
          )}

          {error && !summary && (
            <div className="papr-plan__error">{error}</div>
          )}

          {summary && (
            <>
              <div className="papr-plan__summary">
                <div>
                  <div className="papr-plan__plan-name">{summary.planName}</div>
                  <div className="papr-plan__plan-features">{summary.planFeatures}</div>
                  {summary.subscriptionStatus && (
                    <div className="papr-plan__plan-meta">
                      Status: {summary.subscriptionStatus}
                      {summary.trialEnd
                        ? ` · Trial ends ${new Date(summary.trialEnd).toLocaleDateString()}`
                        : ""}
                    </div>
                  )}
                </div>
                {summary.canManageBilling ? (
                  <button
                    type="button"
                    className="papr-plan__primary-btn"
                    onClick={() => void handlePortal()}
                  >
                    Manage billing
                  </button>
                ) : (
                  <button
                    type="button"
                    className="papr-plan__secondary-btn"
                    onClick={() => void window.electronAPI.papr.openUsageDashboard()}
                  >
                    Open usage
                  </button>
                )}
              </div>

                  {summary.isTrialPeriod && (
                    <div className="papr-plan__plan-meta">
                      Trial active — Developer limits apply until your trial ends.
                    </div>
                  )}

              {(summary.warnings.operationsExceeded ||
                summary.warnings.memoriesExceeded ||
                summary.warnings.storageExceeded) && (
                <div className="papr-plan__alert" data-tone="exceeded">
                  You&apos;ve reached a plan limit.
                  {summary.canManageBilling
                    ? " Upgrade your plan or enable metered billing to keep using Papr Memory."
                    : " Ask your workspace owner to upgrade or enable metered billing."}
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
                    Metered billing is on. Usage above your plan limits will be billed
                    pay-as-you-go.
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

              {summary.canManageBilling ? (
                <>
                  {summary.planTier === "developer" && (
                    <div className="papr-plan__upgrade">
                      <span className="papr-plan__upgrade-label">Upgrade plan</span>
                      <div className="papr-plan__upgrade-actions">
                        <button
                          type="button"
                          className="papr-plan__secondary-btn"
                          disabled={checkoutTier !== null}
                          onClick={() => void handleCheckout("starter")}
                        >
                          {checkoutTier === "starter" ? <Spinner /> : "Starter"}
                        </button>
                        <button
                          type="button"
                          className="papr-plan__secondary-btn"
                          disabled={checkoutTier !== null}
                          onClick={() => void handleCheckout("growth")}
                        >
                          {checkoutTier === "growth" ? <Spinner /> : "Growth"}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="papr-plan__metered">
                    <div>
                      <div className="papr-plan__metered-title">Metered billing</div>
                      <div className="papr-plan__metered-copy">
                        Continue using Papr Memory beyond plan limits with pay-as-you-go
                        billing.
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`papr-plan__toggle-btn ${summary.isMeteredBillingOn ? "papr-plan__toggle-btn--on" : ""}`}
                      onClick={() => void handleMeteredToggle()}
                      disabled={meteredSaving || !summary.subscriptionObjectId}
                      aria-pressed={summary.isMeteredBillingOn}
                    >
                      <span className="papr-plan__toggle-knob" />
                    </button>
                  </div>

                  {!summary.stripeCustomerId && (
                    <p className="papr-plan__hint">
                      Add a payment method in billing settings before enabling metered
                      billing.
                    </p>
                  )}

                  <button
                    type="button"
                    className="papr-plan__link-btn"
                    onClick={() => void handlePortal("billing")}
                  >
                    Add payment method
                  </button>
                </>
              ) : (
                <p className="papr-plan__hint">
                  Billing changes require the workspace owner. You can still view usage
                  here; contact your owner to upgrade or enable metered billing.
                </p>
              )}

              {actionMessage && (
                <p className="papr-plan__message">{actionMessage}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
