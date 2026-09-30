import { describe, expect, it } from "vitest";
import { resolvePostNavigationSettleMs } from "../src/gateway/services/platforms/platformBrowserSettle.js";

describe("platformBrowserSettle", () => {
  it("uses LinkedIn rate-limit midpoint for linkedin.com URLs", () => {
    expect(
      resolvePostNavigationSettleMs("https://www.linkedin.com/in/example/"),
    ).toBe(5500);
  });

  it("uses platform id when provided", () => {
    expect(
      resolvePostNavigationSettleMs("https://example.com/page", "reddit"),
    ).toBe(2000);
  });

  it("falls back for generic URLs", () => {
    expect(resolvePostNavigationSettleMs("https://example.com/page")).toBe(1500);
  });
});
