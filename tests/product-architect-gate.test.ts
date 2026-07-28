import { describe, expect, test } from "vitest";
import {
  PRODUCT_ARCHITECT_ID,
  PRODUCT_ARCHITECT_PLAN_REMINDER,
  PRODUCT_ARCHITECT_REMINDER,
  requiresProductArchitectApproval,
} from "../src/core/utils/productArchitectGate.js";

describe("productArchitectGate", () => {
  test("PRODUCT_ARCHITECT_ID is stable", () => {
    expect(PRODUCT_ARCHITECT_ID).toBe("product-architect");
  });

  test("reminders mention enforcement", () => {
    expect(PRODUCT_ARCHITECT_REMINDER.toLowerCase()).toContain("enforced");
    expect(PRODUCT_ARCHITECT_PLAN_REMINDER.toLowerCase()).toContain(
      "product-architect",
    );
  });

  test("requiresProductArchitectApproval gates create_app always", () => {
    expect(requiresProductArchitectApproval({ tool: "create_app" })).toBe(
      true,
    );
  });

  test("requiresProductArchitectApproval gates linked app jobs", () => {
    expect(
      requiresProductArchitectApproval({
        tool: "create_job",
        jobType: "python",
        appIds: ["app-123"],
      }),
    ).toBe(true);
  });

  test("requiresProductArchitectApproval allows standalone unscheduled jobs", () => {
    expect(
      requiresProductArchitectApproval({
        tool: "create_job",
        jobType: "python",
        appIds: ["__standalone__"],
        schedule: { enabled: false },
      }),
    ).toBe(false);
  });

  test("requiresProductArchitectApproval gates agent jobs", () => {
    expect(
      requiresProductArchitectApproval({
        tool: "create_job",
        jobType: "agent",
        appIds: ["__standalone__"],
      }),
    ).toBe(true);
  });
});
