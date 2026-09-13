import { beforeEach, describe, expect, it } from "vitest";
import {
  usePaprQuotaStore,
  resetPaprQuotaForWorkspaceSwitch,
} from "../ui/stores/paprQuotaStore";

describe("paprQuotaStore workspace switch", () => {
  beforeEach(() => {
    usePaprQuotaStore.setState({ active: null, dismissedKey: null });
  });

  it("clears an active subscription banner when switching workspace", () => {
    usePaprQuotaStore.getState().setQuotaStatus({
      kind: "subscription",
      severity: "exceeded",
      title: "Subscription cancelled.",
      detail: "Papr Cloud features paused. Local chat works.",
      suggestMeteredBilling: false,
      billingUrl: "https://dashboard.papr.ai/usage",
      reportedAt: new Date().toISOString(),
    });

    expect(usePaprQuotaStore.getState().active?.kind).toBe("subscription");

    resetPaprQuotaForWorkspaceSwitch();

    expect(usePaprQuotaStore.getState().active).toBeNull();
    expect(usePaprQuotaStore.getState().dismissedKey).toBeNull();
  });
});
