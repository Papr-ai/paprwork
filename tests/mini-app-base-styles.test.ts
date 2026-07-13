import { describe, it, expect } from "vitest";
import { injectMiniAppBaseStyles } from "../src/gateway/utils/miniAppBaseStyles.js";

describe("injectMiniAppBaseStyles", () => {
  it("injects base and brand style tags into head", () => {
    const html = "<html><head></head><body></body></html>";
    const brandTag =
      '<style data-paprwork-brand>:root { --brand-primary: #2563EB; }</style>';
    const result = injectMiniAppBaseStyles(html, brandTag);

    expect(result).toContain("data-paprwork-base");
    expect(result).toContain("data-paprwork-brand");
    expect(result).toContain("--brand-primary");
  });

  it("is idempotent when tags already present", () => {
    const html =
      '<html><head><style data-paprwork-base></style><style data-paprwork-brand></style></head></html>';
    const result = injectMiniAppBaseStyles(html, "<style data-paprwork-brand>x</style>");
    expect(result.match(/data-paprwork-base/g)?.length).toBe(1);
    expect(result.match(/data-paprwork-brand/g)?.length).toBe(1);
  });
});
