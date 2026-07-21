import { describe, expect, it } from "vitest";
import {
  getMiniAppContentType,
  isMiniAppBinaryExtension,
} from "../src/gateway/utils/miniAppStaticAssets.js";

describe("miniAppStaticAssets", () => {
  it("treats font files as binary", () => {
    expect(isMiniAppBinaryExtension(".ttf")).toBe(true);
    expect(isMiniAppBinaryExtension(".woff2")).toBe(true);
    expect(getMiniAppContentType(".ttf")).toBe("font/ttf");
  });

  it("treats text assets as non-binary", () => {
    expect(isMiniAppBinaryExtension(".html")).toBe(false);
    expect(isMiniAppBinaryExtension(".css")).toBe(false);
    expect(isMiniAppBinaryExtension(".ts")).toBe(false);
  });

  it("treats images as binary", () => {
    expect(isMiniAppBinaryExtension(".png")).toBe(true);
    expect(getMiniAppContentType(".png")).toBe("image/png");
  });
});
