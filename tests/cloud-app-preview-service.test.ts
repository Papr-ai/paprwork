import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRuntimeRouteAuth } from "../src/gateway/services/appRuntime/types.js";

const { fetchCachedRuntimeRepoFile, resolvePublishedApp } = vi.hoisted(() => ({
  fetchCachedRuntimeRepoFile: vi.fn(),
  resolvePublishedApp: vi.fn(),
}));

vi.mock("../src/gateway/services/appRuntime/cloudAppHostCache.js", () => ({
  fetchCachedRuntimeRepoFile,
}));

vi.mock("../src/gateway/services/appRuntime/cloudAppPublishClient.js", () => ({
  resolvePublishedApp,
}));

import {
  resolveCloudAppPreviewMeta,
  resolvePreviewIconSvg,
  resolveShareGatePresentation,
} from "../src/gateway/services/appRuntime/CloudAppPreviewService.js";

const auth: AppRuntimeRouteAuth = {
  namespaceId: "8Pu0Oc6pIh",
  slug: "talent-assessment-1-1",
};

describe("CloudAppPreviewService gate fallbacks", () => {
  beforeEach(() => {
    fetchCachedRuntimeRepoFile.mockReset();
    resolvePublishedApp.mockReset();
    resolvePublishedApp.mockResolvedValue({
      slug: "talent-assessment-1-1",
      visibility: "team",
    });
  });

  it("skips repo-file for unsigned visitors (canReadRepo false)", async () => {
    const meta = await resolveCloudAppPreviewMeta({
      runtimeAuth: auth,
      publicBaseUrl: "https://apps.papr.ai",
      canReadRepo: false,
    });

    expect(fetchCachedRuntimeRepoFile).not.toHaveBeenCalled();
    expect(meta.title).toBe("Talent Assessment 1 1");
  });

  it("falls back to slug meta when repo-file returns 403 and catalog is missing", async () => {
    fetchCachedRuntimeRepoFile.mockRejectedValue(
      new Error('Runtime repo-file failed (403): {"detail":"Access denied"}'),
    );
    resolvePublishedApp.mockResolvedValue({
      slug: "talent-assessment-1-1",
      visibility: "team",
    });

    const meta = await resolveCloudAppPreviewMeta({
      runtimeAuth: auth,
      publicBaseUrl: "https://apps.papr.ai",
      canReadRepo: true,
    });

    expect(meta.title).toBe("Talent Assessment 1 1");
  });

  it("uses publish catalog branding when repo-file is unavailable", async () => {
    resolvePublishedApp.mockResolvedValue({
      slug: "talent-assessment-1-1",
      visibility: "team",
      catalogTitle: "Talent Assessment_1",
      catalogDescription: "Standalone talent assessment mini-app.",
      catalogIcon:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2"/></svg>',
    });

    const meta = await resolveCloudAppPreviewMeta({
      runtimeAuth: auth,
      publicBaseUrl: "https://apps.papr.ai",
      canReadRepo: false,
      publishedApp: {
        orgId: "org",
        namespaceId: auth.namespaceId,
        userId: "user",
        appId: "app",
        slug: auth.slug,
        visibility: "team",
        linkPermission: "read",
        catalogTitle: "Talent Assessment_1",
        catalogDescription: "Standalone talent assessment mini-app.",
      },
    });

    expect(fetchCachedRuntimeRepoFile).not.toHaveBeenCalled();
    expect(meta.title).toBe("Talent Assessment_1");
    expect(meta.description).toBe("Standalone talent assessment mini-app.");
  });

  it("uses publish catalog icon when repo icon fetch fails", async () => {
    fetchCachedRuntimeRepoFile.mockRejectedValue(
      new Error('Runtime repo-file failed (403): {"detail":"Access denied"}'),
    );
    resolvePublishedApp.mockResolvedValue({
      slug: "talent-assessment-1-1",
      visibility: "team",
      catalogIcon:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2"/></svg>',
    });

    const svg = await resolvePreviewIconSvg(auth, false);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).not.toContain("#0060E0");
  });
});

describe("resolveShareGatePresentation", () => {
  it("uses short user-facing copy when signed in but not on team", () => {
    const presentation = resolveShareGatePresentation({
      hasSession: true,
      hasShareToken: false,
      visibility: "team",
    });

    expect(presentation.headline).toBe("No access");
    expect(presentation.message).toContain("isn't shared with your account");
    expect(presentation.message).not.toContain("Settings");
    expect(presentation.message).not.toContain("Update web version");
    expect(presentation.showLoginButton).toBe(false);
  });
});
