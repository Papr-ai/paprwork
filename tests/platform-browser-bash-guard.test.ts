import { describe, expect, it } from "vitest";
import {
  detectManualAuthCheckpoint,
  detectPlatformBrowserBashTip,
  formatPlatformBrowserBashTip,
} from "../src/core/utils/platformBrowserBashGuard.js";

describe("platformBrowserBashGuard", () => {
  it("tips on curl to linkedin.com (does not block)", () => {
    const tip = detectPlatformBrowserBashTip(
      "curl -s 'https://www.linkedin.com/voyager/api/me'",
    );
    expect(tip?.message).toContain("Tip:");
    expect(formatPlatformBrowserBashTip(tip!)).toContain("browser_snapshot");
  });

  it("tips on curl with LINKEDIN key substitution", () => {
    const tip = detectPlatformBrowserBashTip(
      "curl -H 'Cookie: li_at=${LINKEDIN_LI_AT}' https://www.linkedin.com/feed/",
    );
    expect(tip).not.toBeNull();
  });

  it("allows curl to localhost gateway without tip", () => {
    const tip = detectPlatformBrowserBashTip(
      "curl -s http://localhost:18789/api/jobs/status",
    );
    expect(tip).toBeNull();
  });

  it("detects Google passkey checkpoint in snapshot HTML", () => {
    const tip = detectManualAuthCheckpoint(
      '<html><body>Verifying it\'s you... Complete sign-in using your passkey</body></html>',
    );
    expect(tip).toContain("Manual sign-in");
    expect(tip).toContain("Try another way");
  });
});
