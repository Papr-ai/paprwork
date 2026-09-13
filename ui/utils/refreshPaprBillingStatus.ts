import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import { hasActivePaprSubscription } from "../../src/core/utils/paprPlanLimits";
import { gateway } from "../src/lib/gateway";
import { useCloudMemoryStatusStore } from "../stores/cloudMemoryStatusStore";
import { resetPaprQuotaForWorkspaceSwitch } from "../stores/paprQuotaStore";
import { useProfileStore } from "../stores/profileStore";
import { deriveCloudMemoryStatus } from "./cloudMemoryStatus";

export function resetBillingUiForWorkspaceSwitch(): void {
  resetPaprQuotaForWorkspaceSwitch();
  useCloudMemoryStatusStore.getState().setBillingState(null);
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
      try {
        await gateway.send("papr:resume-cloud", {});
      } catch (error) {
        console.warn("[Billing] Failed to resume Papr Cloud:", error);
      }
    }

    return summary;
  } catch {
    useCloudMemoryStatusStore.getState().setBillingState(null);
    return null;
  }
}
