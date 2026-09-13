import React from "react";
import type { PaprCloudFeatureId } from "../../../src/core/constants/paprCloudFeatures";
import {
  formatSubscriptionStatusLabel,
  subscriptionStatusTone,
} from "../../../src/core/utils/paprPlanLimits";
import { useCloudMemoryStatusStore } from "../../stores/cloudMemoryStatusStore";
import { usePaprCloudFeatureStore } from "../../stores/paprCloudFeatureStore";
import { openPaprPlanSettings, planNeedsAttention } from "../../utils/cloudMemoryStatus";
import {
  buildPaprCloudRequirementRows,
  paprCloudPanelNeedsAttention,
  runPaprCloudFixAction,
} from "../../utils/paprCloudRequirementsUi";
import { openPaprLoginSettings } from "../../utils/paprCloudFeatureUi";
import "./PaprCloudRequirementsPanel.css";

interface PaprCloudRequirementsPanelProps {
  featureId: PaprCloudFeatureId;
  /** Reserved for callers that embed in tight spaces (popover). */
  compact?: boolean;
}

export function PaprCloudRequirementsPanel({
  featureId,
}: PaprCloudRequirementsPanelProps): React.ReactElement | null {
  const context = usePaprCloudFeatureStore((state) => state.context);
  const cloudStatus = useCloudMemoryStatusStore((state) => state.status);
  const planSummary = useCloudMemoryStatusStore((state) => state.planSummary);

  if (!context) {
    return null;
  }

  const { access } = buildPaprCloudRequirementRows(featureId, context);
  const cloudSyncOff = context.isLoggedIn && !context.cloudSyncEnabled;

  if (
    !paprCloudPanelNeedsAttention({
      context,
      accessAllowed: access.allowed,
      cloudStatus,
      planSummary,
    })
  ) {
    return null;
  }

  if (!context.isLoggedIn) {
    return (
      <div className="papr-cloud-reqs" data-blocked="true" role="status">
        <p className="papr-cloud-reqs__title">Papr Cloud</p>
        <p className="papr-cloud-reqs__detail">Sign in to publish and sync with Papr Cloud.</p>
        <button
          type="button"
          className="papr-cloud-reqs__action"
          onClick={openPaprLoginSettings}
        >
          Sign in
        </button>
      </div>
    );
  }

  const planName = planSummary?.planName ?? "Plan";
  const statusLabel = planSummary?.subscriptionStatus
    ? formatSubscriptionStatusLabel(planSummary.subscriptionStatus)
    : null;
  const statusTone = planSummary?.subscriptionStatus
    ? subscriptionStatusTone(planSummary.subscriptionStatus)
    : "inactive";
  const detail =
    cloudStatus?.detail ??
    (access.allowed
      ? "Turn on Cloud Sync in Settings to publish and sync."
      : "Papr Cloud paused. Local chat still works.");
  const meteredOn = planSummary?.isMeteredBillingOn ?? false;
  const showPlanAction =
    !access.allowed ||
    (planSummary !== null && planNeedsAttention(planSummary));

  return (
    <div
      className="papr-cloud-reqs"
      role="status"
      data-ready={access.allowed ? "true" : "false"}
      data-blocked={access.allowed ? "false" : "true"}
    >
      <p className="papr-cloud-reqs__title">Papr Cloud</p>

      <div className="papr-cloud-reqs__plan-row">
        <span className="papr-cloud-reqs__plan-name">{planName}</span>
        {statusLabel ? (
          <span className="papr-cloud-reqs__status-pill" data-tone={statusTone}>
            {statusLabel}
          </span>
        ) : null}
        {meteredOn ? (
          <span className="papr-cloud-reqs__status-pill" data-tone="active">
            Metered on
          </span>
        ) : null}
      </div>

      <p className="papr-cloud-reqs__detail">{detail}</p>

      <div className="papr-cloud-reqs__actions">
        {showPlanAction ? (
          <button
            type="button"
            className="papr-cloud-reqs__action"
            onClick={openPaprPlanSettings}
          >
            Plan & usage
          </button>
        ) : null}
        {cloudSyncOff ? (
          <button
            type="button"
            className="papr-cloud-reqs__action papr-cloud-reqs__action--secondary"
            onClick={() => runPaprCloudFixAction("enable_cloud_sync")}
          >
            Cloud Sync settings
          </button>
        ) : null}
      </div>

      {!access.allowed && access.localFallback ? (
        <p className="papr-cloud-reqs__fallback">{access.localFallback}</p>
      ) : null}
    </div>
  );
}
