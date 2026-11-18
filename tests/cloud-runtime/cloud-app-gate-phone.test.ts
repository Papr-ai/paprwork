import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCloudAuthLoginUrl,
  buildPreviewLandingHtml,
  CLOUD_APP_IDENTIFIER_PLACEHOLDER,
  CLOUD_APP_OTHER_SIGN_IN_LABEL,
} from "../../src/core/utils/cloudAppPreview.js";
import { parseSignInIdentifier } from "../../src/core/utils/paprAuth0Pkce.js";
import {
  allowSmsSignInAttempt,
  resetSmsSignInLimiter,
  SMS_SIGNIN_LIMITS,
} from "../../src/gateway/services/appRuntime/smsSignInLimiter.js";

const meta = { title: "Chores", description: "", canonicalUrl: "https://apps.papr.ai/ns/chores/", iconUrl: "/icon.png", imageUrl: "/og.png", siteName: "Papr" };

describe("sign-in gate one box", () => {
  it("posts phone-or-email to /auth/login with the app's returnTo", () => {
    const loginUrl = buildCloudAuthLoginUrl("/ns/chores/");
    const html = buildPreviewLandingHtml(meta, "", { loginUrl });
    expect(html).toContain('method="post" action="/auth/login"');
    expect(html).toContain('name="identifier"');
    expect(html).toContain(`placeholder="${CLOUD_APP_IDENTIFIER_PLACEHOLDER}"`);
    expect(html).toContain('name="returnTo" value="/ns/chores/"');
    expect(html).toContain(CLOUD_APP_OTHER_SIGN_IN_LABEL);
  });

  it("no form when the gate has no sign-in", () => {
    const html = buildPreviewLandingHtml(meta, "", { showLoginButton: false });
    expect(html).not.toContain('name="identifier"');
  });

  it("buildCloudAuthLoginUrl still supports phone mode", () => {
    expect(buildCloudAuthLoginUrl("/x", "phone")).toBe("/auth/login?returnTo=%2Fx&mode=phone");
    expect(buildCloudAuthLoginUrl("/x")).toBe("/auth/login?returnTo=%2Fx");
  });
});

describe("parseSignInIdentifier", () => {
  it.each([
    ["(206) 555-0123", "+12065550123"],
    ["206.555.0123", "+12065550123"],
    ["1 206 555 0123", "+12065550123"],
    ["+44 7700 900123", "+447700900123"],
  ])("phone %s → %s", (raw, value) => {
    expect(parseSignInIdentifier(raw)).toEqual({ kind: "phone", value });
  });

  it("emails are trimmed and lowercased", () => {
    expect(parseSignInIdentifier("  Amir@Papr.AI ")).toEqual({ kind: "email", value: "amir@papr.ai" });
  });

  it.each(["", "hello", "555-0123", "a@b", "+1", "12345678901234567", 42])("rejects %s", (raw) => {
    expect(parseSignInIdentifier(raw)).toBeNull();
  });
});

describe("sms sign-in limiter", () => {
  beforeEach(() => resetSmsSignInLimiter());

  it("caps texts per phone number", () => {
    for (let i = 0; i < SMS_SIGNIN_LIMITS.perPhone; i++) {
      expect(allowSmsSignInAttempt(`ip${i}`, "+12065550123")).toBe(true);
    }
    expect(allowSmsSignInAttempt("ip-new", "+12065550123")).toBe(false);
  });

  it("caps texts per IP across numbers, and resets after the window", () => {
    const t = 1_000_000;
    for (let i = 0; i < SMS_SIGNIN_LIMITS.perIp; i++) {
      expect(allowSmsSignInAttempt("1.2.3.4", `+1206555000${i}`, t)).toBe(true);
    }
    expect(allowSmsSignInAttempt("1.2.3.4", "+12065559999", t)).toBe(false);
    expect(allowSmsSignInAttempt("1.2.3.4", "+12065559999", t + 11 * 60 * 1000)).toBe(true);
  });
});
