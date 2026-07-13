import { describe, expect, test } from "vitest";
import { PRODUCT_ARCHITECT_ID } from "../src/core/utils/productArchitectGate.js";

describe("productArchitectGate", () => {
  test("PRODUCT_ARCHITECT_ID is stable", () => {
    expect(PRODUCT_ARCHITECT_ID).toBe("product-architect");
  });
});
