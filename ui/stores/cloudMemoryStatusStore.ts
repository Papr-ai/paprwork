import { create } from "zustand";
import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import type { CloudMemoryStatus } from "../utils/cloudMemoryStatus";
import {
  sameCloudMemoryStatus,
  samePlanSummary,
} from "../utils/storeWriteGuards";

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
    set((prev) => {
      // `deriveCloudMemoryStatus` builds a fresh object from unchanged data, so
      // writing unconditionally reported a change on every billing refresh —
      // and anything subscribed to `status` then re-ran. Keep the previous
      // references when the content matches so subscribers can bail out.
      const statusUnchanged = sameCloudMemoryStatus(prev.status, status);
      const summaryUnchanged = samePlanSummary(prev.planSummary, planSummary);
      if (statusUnchanged && summaryUnchanged) {
        return prev;
      }
      return {
        status: statusUnchanged ? prev.status : status,
        planSummary: summaryUnchanged ? prev.planSummary : planSummary,
        planAttention: status !== null,
      };
    }),
}));
