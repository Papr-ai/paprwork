import { describe, it, expect } from "vitest";
import { realChromeUserAgent } from "../src/core/tools/browser.js";

describe("realChromeUserAgent", () => {
  it("looks like desktop Chrome, not HeadlessChrome", () => {
    const ua = realChromeUserAgent("131.0.6778.33", "darwin");
    expect(ua).toContain("Chrome/131.0.6778.33");
    expect(ua).toContain("Macintosh");
    expect(ua).not.toMatch(/Headless/);
    expect(realChromeUserAgent("weird", "linux")).toContain("X11; Linux");
  });
});
