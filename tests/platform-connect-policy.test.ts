import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/services/platforms/platformChromeEnv.js", () => ({
  isGoogleChromeInstalled: vi.fn(() => false),
  getGoogleChromeExecutablePath: vi.fn(() => null),
}));

import { isGoogleChromeInstalled } from "../src/gateway/services/platforms/platformChromeEnv.js";
import {
  allowsEmbeddedPlatformSession,
  allowsPersonalChromeCookieImport,
} from "../src/gateway/services/platforms/platformConnectPolicy.js";

describe("platformConnectPolicy", () => {
  afterEach(() => {
    vi.mocked(isGoogleChromeInstalled).mockReturnValue(false);
  });

  it("disallows personal Chrome import for LinkedIn", () => {
    expect(allowsPersonalChromeCookieImport("linkedin")).toBe(false);
  });

  it("allows personal Chrome import for other platforms", () => {
    expect(allowsPersonalChromeCookieImport("twitter")).toBe(true);
    expect(allowsPersonalChromeCookieImport("reddit")).toBe(true);
    expect(allowsPersonalChromeCookieImport("instagram")).toBe(true);
  });

  it("allows embedded session for LinkedIn when Chrome is not installed", () => {
    vi.mocked(isGoogleChromeInstalled).mockReturnValue(false);
    expect(allowsEmbeddedPlatformSession("linkedin")).toBe(true);
  });

  it("disallows embedded session for LinkedIn when Chrome is installed", () => {
    vi.mocked(isGoogleChromeInstalled).mockReturnValue(true);
    expect(allowsEmbeddedPlatformSession("linkedin")).toBe(false);
  });

  it("allows embedded session for other platforms when Chrome is installed", () => {
    vi.mocked(isGoogleChromeInstalled).mockReturnValue(true);
    expect(allowsEmbeddedPlatformSession("twitter")).toBe(true);
    expect(allowsEmbeddedPlatformSession("reddit")).toBe(true);
  });
});
