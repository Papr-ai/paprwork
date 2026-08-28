import { describe, expect, test } from "vitest";
import {
  PRODUCT_ARCHITECT_ID,
  CREATE_APP_IMPLEMENTATION_REMINDER,
  PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION,
  PRODUCT_ARCHITECT_PLAN_REMINDER,
  PRODUCT_ARCHITECT_REMINDER,
  requiresProductArchitectApproval,
} from "../src/core/utils/productArchitectGate.js";

describe("productArchitectGate", () => {
  test("PRODUCT_ARCHITECT_ID is stable", () => {
    expect(PRODUCT_ARCHITECT_ID).toBe("product-architect");
  });

  test("reminders mention enforcement", () => {
    expect(PRODUCT_ARCHITECT_REMINDER.toLowerCase()).toContain("create_app");
    expect(PRODUCT_ARCHITECT_REMINDER).toContain("useAgentId");
    expect(PRODUCT_ARCHITECT_PLAN_REMINDER.toLowerCase()).toContain(
      "product-architect",
    );
  });

  test("implementation contracts cover platform wiring pitfalls", () => {
    expect(PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION).toContain(
      "PAPR_ACTION_PARAMS",
    );
    expect(PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION).toContain(
      "sys.stdin",
    );
    expect(PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION).toContain("sql");
    expect(PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION).toContain(
      "papr_db_apply_migration",
    );
    expect(CREATE_APP_IMPLEMENTATION_REMINDER).toContain("preloaded-app-and-jobs-guide");
    expect(CREATE_APP_IMPLEMENTATION_REMINDER).toContain("exitCode");
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
