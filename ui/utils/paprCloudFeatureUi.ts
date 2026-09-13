import type { PaprCloudFeatureAccessResult } from "../../src/core/utils/paprCloudFeatureAccess";
import { ensureSettingsTab } from "../lib/ensureSettingsTab";
import { usePaprCloudFeatureStore } from "../stores/paprCloudFeatureStore";

export function openPaprPlanSettings(): void {
  ensureSettingsTab({ section: "billing", focusPlan: true });
}

export function openPaprLoginSettings(): void {
  ensureSettingsTab({ section: "models" });
}

export function openCloudSyncSettings(): void {
  ensureSettingsTab({ section: "cloud" });
}

export function showPaprCloudFeatureLock(
  result: PaprCloudFeatureAccessResult,
): void {
  usePaprCloudFeatureStore.getState().showLockModal(result);
}
