import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import { hasActivePaprSubscription } from "../../src/core/utils/paprPlanLimits";
import { gateway } from "../src/lib/gateway";
import { useCloudMemoryStatusStore } from "../stores/cloudMemoryStatusStore";
import { resetPaprQuotaForWorkspaceSwitch } from "../stores/paprQuotaStore";
import { useProfileStore } from "../stores/profileStore";
import { deriveCloudMemoryStatus } from "./cloudMemoryStatus";

/** Min interval between papr:resume-cloud gateway calls (avoids timeout loops when degraded). */
const RESUME_CLOUD_MIN_INTERVAL_MS = 120_000;

let lastResumeCloudAttemptMs = 0;

export function resetBillingUiForWorkspaceSwitch(): void {
  resetPaprQuotaForWorkspaceSwitch();
  useCloudMemoryStatusStore.getState().setBillingState(null);
  lastResumeCloudAttemptMs = 0;
}

export async function refreshPaprBillingStatus(options?: {
  force?: boolean;
}): Promise<PaprPlanSummary | null> {
  try {
    const result = await window.electronAPI.papr.getPlanSummary({
      force: options?.force,
    });
    if (!result.success || !result.summary) {
      useCloudMemoryStatusStore.getState().setBillingState(null);
      return null;
    }

    const summary = result.summary;
    useProfileStore.getState().setProfile({ plan: summary.planName });
    useCloudMemoryStatusStore
      .getState()
      .setBillingState(deriveCloudMemoryStatus(summary), summary);

    window.dispatchEvent(
      new CustomEvent("papr:billing-refreshed", { detail: { summary } }),
    );

    if (hasActivePaprSubscription(summary)) {
      const connectionState = gateway.getConnectionState();
      if (connectionState === "degraded") {
        console.warn(
          "[Billing] Skipping papr:resume-cloud — gateway busy (will retry on next refresh)",
        );
      } else {
        const now = Date.now();
        const mayResume =
          options?.force === true ||
          now - lastResumeCloudAttemptMs >= RESUME_CLOUD_MIN_INTERVAL_MS;
        if (mayResume) {
          lastResumeCloudAttemptMs = now;
          try {
            await gateway.send("papr:resume-cloud", {});
          } catch (error) {
            console.warn("[Billing] Failed to resume Papr Cloud:", error);
          }
        }
      }
    }

    return summary;
  } catch {
    useCloudMemoryStatusStore.getState().setBillingState(null);
    return null;
  }
}
