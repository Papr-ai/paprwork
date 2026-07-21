import { describe, expect, test } from "vitest";
import {
  PRODUCT_ARCHITECT_ID,
  PRODUCT_ARCHITECT_PLAN_REMINDER,
  PRODUCT_ARCHITECT_REMINDER,
} from "../src/core/utils/productArchitectGate.js";

describe("productArchitectGate", () => {
  test("PRODUCT_ARCHITECT_ID is stable", () => {
    expect(PRODUCT_ARCHITECT_ID).toBe("product-architect");
  });

  test("reminders are recommendation-only (not blockers)", () => {
    expect(PRODUCT_ARCHITECT_REMINDER.toLowerCase()).toContain("recommendation");
    expect(PRODUCT_ARCHITECT_PLAN_REMINDER.toLowerCase()).toContain(
      "recommendation",
    );
    expect(PRODUCT_ARCHITECT_REMINDER.toLowerCase()).not.toContain("stop and");
    expect(PRODUCT_ARCHITECT_PLAN_REMINDER.toLowerCase()).not.toContain(
      "stop and",
    );
  });
});
