import { describe, expect, it } from "vitest";
import {
  buildCloudAuthLoginUrl,
  buildPreviewLandingHtml,
  CLOUD_APP_PHONE_BUTTON_LABEL,
} from "../../src/core/utils/cloudAppPreview.js";

const meta = { title: "Chores", description: "", canonicalUrl: "https://apps.papr.ai/ns/chores/", iconUrl: "/icon.png", imageUrl: "/og.png", siteName: "Papr" };

describe("sign-in gate phone option", () => {
  it("shows Continue with phone, pointing at mode=phone with the same returnTo", () => {
    const loginUrl = buildCloudAuthLoginUrl("/ns/chores/");
    const html = buildPreviewLandingHtml(meta, "", { loginUrl });
    expect(html).toContain(CLOUD_APP_PHONE_BUTTON_LABEL);
    expect(html).toContain("/auth/login?returnTo=%2Fns%2Fchores%2F&amp;mode=phone");
  });

  it("no phone button when the gate has no sign-in", () => {
    const html = buildPreviewLandingHtml(meta, "", { showLoginButton: false });
    expect(html).not.toContain(CLOUD_APP_PHONE_BUTTON_LABEL);
  });

  it("buildCloudAuthLoginUrl supports phone mode", () => {
    expect(buildCloudAuthLoginUrl("/x", "phone")).toBe("/auth/login?returnTo=%2Fx&mode=phone");
    expect(buildCloudAuthLoginUrl("/x")).toBe("/auth/login?returnTo=%2Fx");
  });
});
