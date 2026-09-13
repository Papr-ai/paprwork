import { describe, expect, it } from "vitest";
import { buildMeteredBillingMutationVariables } from "../src/electron/ipc/paprBilling.js";
import { requiresPaymentMethodForMeteredBilling } from "../src/core/utils/paprPlanLimits.js";

describe("papr metered billing", () => {
  it("requires a payment method only on the Builder plan", () => {
    expect(
      requiresPaymentMethodForMeteredBilling({
        planTier: "developer",
        hasPaymentMethod: false,
      }),
    ).toBe(true);
    expect(
      requiresPaymentMethodForMeteredBilling({
        planTier: "developer",
        hasPaymentMethod: true,
      }),
    ).toBe(false);
    expect(
      requiresPaymentMethodForMeteredBilling({
        planTier: "intelligence",
        hasPaymentMethod: false,
      }),
    ).toBe(false);
  });

  it("builds the same Parse mutation input as papr-dev-platform", () => {
    expect(
      buildMeteredBillingMutationVariables("sub-abc123", true),
    ).toEqual({
      input: {
        id: "sub-abc123",
        fields: { isMeteredBillingOn: true },
      },
    });
    expect(
      buildMeteredBillingMutationVariables("sub-abc123", false),
    ).toEqual({
      input: {
        id: "sub-abc123",
        fields: { isMeteredBillingOn: false },
      },
    });
  });
});
