import { describe, expect, it } from "vitest";
import {
  appLabelFromReturnTo,
  buildPaprAuthCallbackPageHtml,
  humanizeAppSlug,
} from "../src/resources/mini-app-sdk/papr-auth-ui.js";

describe("papr-auth-ui helpers", () => {
  it("humanizes app slugs", () => {
    expect(humanizeAppSlug("weekly-war-room")).toBe("Weekly War Room");
    expect(humanizeAppSlug("audit_workbench")).toBe("Audit Workbench");
  });

  it("derives app label from published app return paths", () => {
    expect(appLabelFromReturnTo("/ns123/weekly-war-room/")).toBe("Weekly War Room");
    expect(appLabelFromReturnTo("/")).toBeUndefined();
  });
});

describe("buildPaprAuthCallbackPageHtml", () => {
  it("focuses copy on the destination app, not Papr branding", () => {
    const html = buildPaprAuthCallbackPageHtml({
      returnTo: "/ns123/weekly-war-room/",
      appLabel: "Weekly War Room",
    });

    expect(html).toContain("Opening Weekly War Room…");
    expect(html).toContain("You&rsquo;re signed in.");
    expect(html).toContain('href="/ns123/weekly-war-room/"');
    expect(html).toContain("Open Weekly War Room");
    expect(html).not.toContain("Signed in!");
    expect(html).not.toContain("Taking you back");
    expect(html).not.toContain("Continue to app");
    expect(html).not.toContain("papr-auth__right");
    expect(html).not.toContain("Papr</span>");
  });

  it("falls back to generic app copy when label is unknown", () => {
    const html = buildPaprAuthCallbackPageHtml({ returnTo: "/" });

    expect(html).toContain("Opening your app…");
    expect(html).toContain("Open app");
  });
});
