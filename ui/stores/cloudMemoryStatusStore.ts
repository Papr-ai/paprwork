import { create } from "zustand";
import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import type { CloudMemoryStatus } from "../utils/cloudMemoryStatus";

interface CloudMemoryStatusStore {
  status: CloudMemoryStatus | null;
  planSummary: PaprPlanSummary | null;
  planAttention: boolean;
  setBillingState: (
    status: CloudMemoryStatus | null,
    planSummary?: PaprPlanSummary | null,
  ) => void;
}

export const useCloudMemoryStatusStore = create<CloudMemoryStatusStore>((set) => ({
  status: null,
  planSummary: null,
  planAttention: false,
  setBillingState: (status, planSummary = null) =>
    set({
      status,
      planSummary,
      planAttention: status !== null,
    }),
}));
