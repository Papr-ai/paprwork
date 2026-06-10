import { describe, expect, it } from "vitest";
import {
  injectMiniAppBaseStyles,
  MINI_APP_BASE_STYLE_TAG,
} from "../src/gateway/utils/miniAppBaseStyles.js";

describe("injectMiniAppBaseStyles", () => {
  it("injects base styles after <head>", () => {
    const html = "<!DOCTYPE html><html><head><title>T</title></head><body></body></html>";
    const result = injectMiniAppBaseStyles(html);
    expect(result).toContain(MINI_APP_BASE_STYLE_TAG);
    expect(result.indexOf("data-paprwork-base")).toBeLessThan(result.indexOf("<title>"));
  });

  it("is idempotent", () => {
    const html = "<html><head></head></html>";
    const once = injectMiniAppBaseStyles(html);
    const twice = injectMiniAppBaseStyles(once);
    expect(twice.match(/data-paprwork-base/g)?.length).toBe(1);
  });

  it("leaves non-html content unchanged", () => {
    const css = ".card { padding: 8px; }";
    expect(injectMiniAppBaseStyles(css)).toBe(css);
  });
});
