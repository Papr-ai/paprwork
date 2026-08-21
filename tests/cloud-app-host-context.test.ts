import { describe, expect, it } from "vitest";
import {
  injectPaprCloudContextMeta,
  PAPR_CLOUD_NAMESPACE_META,
  PAPR_CLOUD_SLUG_META,
  resolveCloudRouteContext,
  headerSessionToken,
  headerExternalUserId,
} from "../src/gateway/services/appRuntime/cloudAppHostContext.js";

describe("cloudAppHostContext", () => {
  it("prefers request headers over site-wide cookies for namespace/slug", () => {
    const ctx = resolveCloudRouteContext({
      cookieHeader: "papr_cloud_ns=wrong-ns; papr_cloud_slug=wrong-slug",
      headers: {
        "x-papr-namespace-id": "correct-ns",
        "x-papr-slug": "correct-slug",
      },
    });

    expect(ctx).toEqual({ namespaceId: "correct-ns", slug: "correct-slug" });
  });

  it("falls back to cookies when headers are absent", () => {
    const ctx = resolveCloudRouteContext({
      cookieHeader: "papr_cloud_ns=ns-from-cookie; papr_cloud_slug=slug-from-cookie",
    });

    expect(ctx).toEqual({ namespaceId: "ns-from-cookie", slug: "slug-from-cookie" });
  });

  it("injects per-app meta tags into index.html", () => {
    const html = injectPaprCloudContextMeta(
      "<html><head></head><body></body></html>",
      "ns-abc",
      "deck-studio",
    );

    expect(html).toContain(`name="${PAPR_CLOUD_NAMESPACE_META}" content="ns-abc"`);
    expect(html).toContain(`name="${PAPR_CLOUD_SLUG_META}" content="deck-studio"`);
  });

  it("reads desktop proxy session and user headers", () => {
    expect(
      headerSessionToken({ "x-session-token": "sess_from_desktop" }),
    ).toBe("sess_from_desktop");
    expect(
      headerExternalUserId({ "x-papr-external-user-id": "user_abc" }),
    ).toBe("user_abc");
  });
});
