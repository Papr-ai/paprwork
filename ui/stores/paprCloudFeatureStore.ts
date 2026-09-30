import { create } from "zustand";
import type { PaprCloudFeatureId } from "../../src/core/constants/paprCloudFeatures";
import {
  resolvePaprCloudFeatureAccess,
  type PaprCloudAccessContext,
  type PaprCloudFeatureAccessResult,
} from "../../src/core/utils/paprCloudFeatureAccess";
import { sameCloudAccessContext } from "../utils/storeWriteGuards";

interface PaprCloudFeatureStore {
  context: PaprCloudAccessContext | null;
  lockModal: PaprCloudFeatureAccessResult | null;
  setContext: (context: PaprCloudAccessContext | null) => void;
  showLockModal: (result: PaprCloudFeatureAccessResult) => void;
  clearLockModal: () => void;
}

export const usePaprCloudFeatureStore = create<PaprCloudFeatureStore>((set) => ({
  context: null,
  lockModal: null,
  // Rebuilt from unchanged inputs on every refresh, so compare the content:
  // a fresh object with identical fields is not a change worth re-rendering for.
  setContext: (context) =>
    set((prev) =>
      sameCloudAccessContext(prev.context, context) ? prev : { context },
    ),
  showLockModal: (lockModal) => set({ lockModal }),
  clearLockModal: () => set({ lockModal: null }),
}));

/** Returns true when the feature may proceed; otherwise opens the lock modal. */
export function requestPaprCloudFeature(featureId: PaprCloudFeatureId): boolean {
  const { context, showLockModal } = usePaprCloudFeatureStore.getState();
  if (!context) {
    return true;
  }

  const result = resolvePaprCloudFeatureAccess(featureId, context);
  if (result.allowed) {
    return true;
  }

  showLockModal(result);
  return false;
}

export function checkPaprCloudFeature(featureId: PaprCloudFeatureId): PaprCloudFeatureAccessResult | null {
  const { context } = usePaprCloudFeatureStore.getState();
  if (!context) {
    return null;
  }
  return resolvePaprCloudFeatureAccess(featureId, context);
}
