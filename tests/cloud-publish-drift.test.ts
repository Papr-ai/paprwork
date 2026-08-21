import { describe, expect, it } from "vitest";
import {
  detectAutoPublishDrift,
  detectCatalogRequirementsDrift,
  detectPublishDrift,
  prefsSharingFieldsChanged,
  resolveShareTokenForConfig,
  resolveSharingSettingsForDisplay,
  slugifyPublishTitle,
} from "../src/gateway/services/cloudPublishDrift.js";
import {
  isUninitializedSharingPrefs,
  mergeAutoPublishCandidateAppIds,
  needsPublishRecovery,
} from "../src/gateway/services/cloudPublishPrefs.js";
import { resolveUniquePublishSlug } from "../src/gateway/utils/uniqueAppNaming.js";

describe("cloudPublishDrift", () => {
  it("slugifyPublishTitle derives audit-workbench from title", () => {
    expect(slugifyPublishTitle("Audit Workbench")).toBe("audit-workbench");
  });

  it("detects visibility drift between memory and local prefs", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "team",
        slug: "audit-workbench",
        linkPermission: "read",
      },
      prefs: {
        autoPublish: true,
        accessMode: "link_read_write",
        loginAccess: "none",
        externalLink: "read_write",
      },
      expectedSlug: "audit-workbench",
    });
    expect(reasons.some((r) => r.startsWith("visibility:"))).toBe(true);
    expect(reasons).toContain("shareToken:missing");
  });

  it("no slug drift when memory slug matches resolveUniquePublishSlug", () => {
    const appId = "65b7eb05-5ec0-47da-918a-c63e64916f1e";
    const slugCatalog = [
      {
        appId,
        title: "Talent Assessment_1",
        createdAt: "2026-08-15T17:39:23.735Z",
        memorySlug: "talent-assessment-1-1",
      },
    ];
    const expectedSlug = resolveUniquePublishSlug(appId, slugCatalog);
    expect(expectedSlug).toBe("talent-assessment-1-1");

    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "team",
        slug: "talent-assessment-1-1",
        linkPermission: "read_write",
      },
      prefs: {
        autoPublish: true,
        accessMode: "team",
        loginAccess: "team",
        externalLink: "off",
      },
      expectedSlug,
    });
    expect(reasons.some((r) => r.startsWith("slug:"))).toBe(false);
  });

  it("detects slug drift from e2e test pollution", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "link_read_write",
        slug: "e2e-mqw2kn3a",
        linkPermission: "read_write",
        shareToken: "tok",
      },
      prefs: {
        autoPublish: true,
        accessMode: "link_read_write",
        loginAccess: "none",
        externalLink: "read_write",
        shareToken: "tok",
      },
      expectedSlug: "audit-workbench",
    });
    expect(reasons.some((r) => r.startsWith("slug:"))).toBe(true);
  });

  it("detects requireSignIn drift for public Community apps", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "my-app",
        linkPermission: "read",
        requireSignIn: false,
      },
      prefs: {
        autoPublish: true,
        accessMode: "public_read",
        loginAccess: "public",
        externalLink: "off",
        requireSignIn: true,
      },
      expectedSlug: "my-app",
    });
    expect(reasons).toContain("requireSignIn:false→true");
  });

  it("returns no drift when memory matches local prefs", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "link_read_write",
        slug: "audit-workbench",
        linkPermission: "read_write",
        shareToken: "tok",
      },
      prefs: {
        autoPublish: true,
        accessMode: "link_read_write",
        loginAccess: "none",
        externalLink: "read_write",
        shareToken: "cached-tok",
      },
      expectedSlug: "audit-workbench",
    });
    expect(reasons).toEqual([]);
  });

  it("rejects stale cached token when visibility drifted", () => {
    const token = resolveShareTokenForConfig(
      {
        enabled: true,
        visibility: "team",
        slug: "audit-workbench",
      },
      {
        autoPublish: true,
        accessMode: "link_read_write",
        loginAccess: "none",
        externalLink: "read_write",
        shareToken: "stale-tok",
      },
      "audit-workbench",
    );
    expect(token).toBeNull();
  });

  it("allows cached token when cloud config matches local prefs", () => {
    const token = resolveShareTokenForConfig(
      {
        enabled: true,
        visibility: "link_read_write",
        slug: "audit-workbench",
        linkPermission: "read_write",
      },
      {
        autoPublish: true,
        accessMode: "link_read_write",
        loginAccess: "none",
        externalLink: "read_write",
        shareToken: "cached-tok",
      },
      "audit-workbench",
    );
    expect(token).toBe("cached-tok");
  });

  it("prefsSharingFieldsChanged ignores autoPublish-only updates", () => {
    expect(prefsSharingFieldsChanged({ autoPublish: false })).toBe(false);
    expect(prefsSharingFieldsChanged({ accessMode: "team" })).toBe(true);
    expect(prefsSharingFieldsChanged({ externalLink: "read" })).toBe(true);
  });

  it("detects catalog key drift when memory catalog is empty but local has backend keys", () => {
    const reasons = detectCatalogRequirementsDrift(
      [
        {
          name: "RR_ATTENTION_API_KEY",
          service: "Attention",
          category: "other",
          description: "Server-side key",
          required: true,
          credentialScope: "owner",
          clientAccess: "server",
        },
      ],
      {
        enabled: true,
        catalogRequirements: [],
      },
    );
    expect(reasons).toContain("catalogKeys:+RR_ATTENTION_API_KEY");
  });

  it("detects catalog drift via cached prefs when memory omits catalogRequirements", () => {
    const reasons = detectCatalogRequirementsDrift(
      [
        {
          name: "RR_ATTENTION_API_KEY",
          service: "Attention",
          category: "other",
          description: "Server-side key",
          required: true,
          credentialScope: "owner",
          clientAccess: "server",
        },
      ],
      { enabled: true },
      [],
    );
    expect(reasons).toContain("catalogKeys:+RR_ATTENTION_API_KEY");
  });

  it("returns no catalog drift when memory matches local requirements", () => {
    const spec = {
      name: "RR_ATTENTION_API_KEY",
      service: "Attention",
      category: "other" as const,
      description: "Server-side key",
      required: true,
      credentialScope: "owner" as const,
      clientAccess: "server" as const,
    };
    const reasons = detectCatalogRequirementsDrift([spec], {
      enabled: true,
      catalogRequirements: [
        {
          name: spec.name,
          service: spec.service,
          category: spec.category,
          description: spec.description,
          required: spec.required,
          credentialScope: spec.credentialScope,
          clientAccess: spec.clientAccess,
        },
      ],
    });
    expect(reasons).toEqual([]);
  });

  it("treats null catalogRequirements from memory as omitted (no throw)", () => {
    expect(() =>
      detectCatalogRequirementsDrift(
        [],
        { enabled: true, catalogRequirements: null as unknown as [] },
        [],
      ),
    ).not.toThrow();
    expect(
      detectCatalogRequirementsDrift(
        [],
        { enabled: true, catalogRequirements: null as unknown as [] },
        [],
      ),
    ).toEqual([]);
  });

  it("detectPublishDrift does not throw when memory catalogRequirements is null", () => {
    expect(() =>
      detectPublishDrift({
        memory: {
          enabled: true,
          visibility: "private",
          slug: "icp-map",
          linkPermission: "read",
          catalogRequirements: null as unknown as [],
        },
        prefs: {
          autoPublish: true,
          accessMode: "private",
          loginAccess: "private",
          externalLink: "off",
          credentialRequirements: [],
        },
        expectedSlug: "icp-map",
        localCatalogRequirements: [],
      }),
    ).not.toThrow();
  });

  it("detects linkPermission drift even when prefs cached stale liveLinkPermission", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "gtm-audit",
        linkPermission: "read",
      },
      prefs: {
        autoPublish: true,
        accessMode: "public_read",
        loginAccess: "public",
        externalLink: "off",
        codeAccess: "install",
        liveLinkPermission: "read",
      },
      expectedSlug: "gtm-audit",
    });
    expect(reasons).toContain("linkPermission:read→read_write");
  });

  it("detects linkPermission drift for public community apps", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "gtm-audit",
        linkPermission: "read",
      },
      prefs: {
        autoPublish: true,
        accessMode: "public_read",
        loginAccess: "public",
        externalLink: "off",
      },
      expectedSlug: "gtm-audit",
    });
    expect(reasons).toContain("linkPermission:read→read_write");
  });

  it("detectPublishDrift includes catalog key drift", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "audit-workbench",
        linkPermission: "read",
        catalogRequirements: [],
      },
      prefs: {
        autoPublish: true,
        accessMode: "public_read",
        loginAccess: "public",
        externalLink: "off",
      },
      expectedSlug: "audit-workbench",
      localCatalogRequirements: [
        {
          name: "RR_ATTENTION_API_KEY",
          service: "Attention",
          category: "other",
          description: "Server-side key",
          required: true,
          credentialScope: "owner",
          clientAccess: "server",
        },
      ],
    });
    expect(reasons.some((r) => r.startsWith("catalogKeys:"))).toBe(true);
  });

  it("auto-publish drift ignores sharing mismatch (code/catalog only)", () => {
    const prefs = {
      autoPublish: true,
      accessMode: "private" as const,
    };
    expect(isUninitializedSharingPrefs(prefs)).toBe(true);

    const sharingDrift = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "deck-studio",
        linkPermission: "read",
        codeAccess: "install",
      },
      prefs,
      expectedSlug: "deck-studio",
    });
    expect(sharingDrift.some((r) => r.startsWith("visibility:"))).toBe(true);

    const autoDrift = detectAutoPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "deck-studio",
        linkPermission: "read",
        codeAccess: "install",
      },
      prefs,
      expectedSlug: "deck-studio",
    });
    expect(autoDrift).toEqual([]);
  });

  it("resolveSharingSettingsForDisplay reads cloud when local prefs unset", () => {
    const display = resolveSharingSettingsForDisplay(
      { autoPublish: true, accessMode: "private" },
      {
        enabled: true,
        visibility: "public_read",
        linkPermission: "read",
      },
    );
    expect(display.loginAccess).toBe("public");
  });

  it("resolveSharingSettingsForDisplay prefers explicit local prefs", () => {
    const display = resolveSharingSettingsForDisplay(
      {
        autoPublish: true,
        accessMode: "private",
        loginAccess: "team",
        externalLink: "off",
      },
      {
        enabled: true,
        visibility: "public_read",
        linkPermission: "read",
      },
    );
    expect(display.loginAccess).toBe("team");
  });

  it("detectAutoPublishDrift includes title and platform metadata drift", () => {
    const reasons = detectAutoPublishDrift({
      memory: {
        enabled: true,
        slug: "my-app",
        catalogTitle: "Old Title",
        catalogPlatform: ["macos"],
        catalogRequiresDesktop: false,
      },
      prefs: { accessMode: "team" },
      expectedSlug: "my-app",
      localCatalogMetadata: {
        title: "New Title",
        platform: ["macos", "windows", "linux"],
        requiresDesktop: true,
      },
    });
    expect(reasons).toContain("catalogTitle");
    expect(reasons).toContain("catalogPlatform");
    expect(reasons).toContain("catalogRequiresDesktop");
  });
});

describe("cloudPublishPrefs recovery helpers", () => {
  it("needsPublishRecovery when memory disabled but autoPublish on", () => {
    expect(needsPublishRecovery({ enabled: false }, true)).toBe(true);
    expect(needsPublishRecovery(null, true)).toBe(true);
    expect(needsPublishRecovery({ enabled: true }, true)).toBe(false);
    expect(needsPublishRecovery({ enabled: false }, false)).toBe(false);
  });

  it("mergeAutoPublishCandidateAppIds flush scope only includes synced apps", () => {
    const flushIds = mergeAutoPublishCandidateAppIds(
      ["app-a"],
      ["app-b"],
      {
        apps: {
          "app-c": { autoPublish: true, accessMode: "public_read" },
          "app-d": { autoPublish: false, accessMode: "private" },
        },
      },
      "flush",
    );
    expect(flushIds).toEqual(["app-b"]);

    expect(
      mergeAutoPublishCandidateAppIds(
        ["app-a"],
        [],
        { apps: { "app-c": { autoPublish: true, accessMode: "public_read" } } },
        "flush",
      ),
    ).toEqual([]);
  });

  it("mergeAutoPublishCandidateAppIds catalog scope includes prefs-only apps", () => {
    const ids = mergeAutoPublishCandidateAppIds(
      ["app-a"],
      ["app-b"],
      {
        apps: {
          "app-c": { autoPublish: true, accessMode: "public_read" },
          "app-d": { autoPublish: false, accessMode: "private" },
        },
      },
      "catalog",
    );
    expect(ids.sort()).toEqual(["app-b", "app-c"].sort());
  });
});
