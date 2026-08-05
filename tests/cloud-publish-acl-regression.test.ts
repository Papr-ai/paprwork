/**
 * Regression tests for public community app write ACL (GTM Foundations Audit class of bugs).
 *
 * Covers:
 * - v2.2.6 downgrade: memory linkPermission read while UI means interact/edit
 * - stale liveLinkPermission cache must not override computed read_write
 * - infinite recursion when public + externalLink read_write
 * - drift detection must trigger heal republish
 */

import { describe, expect, it } from "vitest";
import {
  liveLinkPermissionForAudienceModel,
  sharingToAudienceModel,
} from "../src/core/utils/shareAudienceModel.js";
import {
  detectPublishDrift,
} from "../src/gateway/services/cloudPublishDrift.js";
import type { CloudPublishAppPrefs } from "../src/gateway/services/cloudPublishPrefs.js";
import {
  resolvePublishFieldsFromPrefs,
  sharingSettingsToPublishFields,
} from "../src/gateway/services/cloudSharingSettings.js";

const GTM_PREFS: Pick<
  CloudPublishAppPrefs,
  "loginAccess" | "externalLink" | "accessMode" | "codeAccess" | "liveLinkPermission"
> = {
  loginAccess: "public",
  externalLink: "off",
  accessMode: "public_read",
  codeAccess: "install",
  liveLinkPermission: "read",
};

function memoryPublishPayload(
  prefs: Pick<
    CloudPublishAppPrefs,
    "loginAccess" | "externalLink" | "accessMode" | "codeAccess"
  >,
): {
  visibility: string;
  linkPermission: string;
  shareLinkEnabled: boolean;
  codeAccess: string;
} {
  const fields = resolvePublishFieldsFromPrefs(prefs);
  return {
    visibility: fields.visibility,
    linkPermission: fields.linkPermission,
    shareLinkEnabled: fields.shareLinkEnabled,
    codeAccess: prefs.codeAccess ?? "off",
  };
}

describe("cloud publish ACL regression (GTM / public community)", () => {
  it("UI: Public in Community + Can edit code → read_write on same public URL", () => {
    const model = sharingToAudienceModel("public", "off", "install");
    expect(model).toEqual({ audience: "public", permission: "edit" });
    expect(liveLinkPermissionForAudienceModel(model)).toBe("read_write");

    expect(memoryPublishPayload(GTM_PREFS)).toEqual({
      visibility: "public_read",
      linkPermission: "read_write",
      shareLinkEnabled: false,
      codeAccess: "install",
    });
  });

  it("UI: Public in Community + Can view and interact → read_write", () => {
    expect(
      memoryPublishPayload({
        loginAccess: "public",
        externalLink: "off",
        accessMode: "public_read",
        codeAccess: "off",
      }),
    ).toEqual({
      visibility: "public_read",
      linkPermission: "read_write",
      shareLinkEnabled: false,
      codeAccess: "off",
    });
  });

  it("ignores stale liveLinkPermission read in prefs (v2.2.6 poisoned cache)", () => {
    const fields = resolvePublishFieldsFromPrefs(GTM_PREFS);
    expect(fields.linkPermission).toBe("read_write");
  });

  it("detects drift when memory server still has linkPermission read", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "gtm-foundations-audit",
        linkPermission: "read",
      },
      prefs: {
        autoPublish: true,
        ...GTM_PREFS,
      },
      expectedSlug: "gtm-foundations-audit",
    });
    expect(reasons).toContain("linkPermission:read→read_write");
  });

  it("no drift after memory matches read_write (healed state)", () => {
    const reasons = detectPublishDrift({
      memory: {
        enabled: true,
        visibility: "public_read",
        slug: "gtm-foundations-audit",
        linkPermission: "read_write",
      },
      prefs: {
        autoPublish: true,
        ...GTM_PREFS,
      },
      expectedSlug: "gtm-foundations-audit",
    });
    expect(reasons.filter((r) => r.startsWith("linkPermission:"))).toEqual([]);
  });

  it("does not stack overflow when agent tries externalLink read_write on public app", () => {
    expect(() =>
      sharingSettingsToPublishFields({
        loginAccess: "public",
        externalLink: "read_write",
      }),
    ).not.toThrow();

    expect(
      resolvePublishFieldsFromPrefs({
        loginAccess: "public",
        externalLink: "read_write",
        accessMode: "public_read",
        codeAccess: "install",
      }),
    ).toEqual({
      visibility: "public_read",
      linkPermission: "read_write",
      shareLinkEnabled: true,
    });
  });

  it("publish_cloud_app args match Share sheet for GTM settings", () => {
    const toolArgs = {
      loginAccess: "public" as const,
      externalLink: "off" as const,
      codeAccess: "install" as const,
    };
    const payload = memoryPublishPayload({
      ...toolArgs,
      accessMode: "public_read",
    });
    expect(payload.linkPermission).toBe("read_write");
    expect(payload.visibility).toBe("public_read");
    expect(payload.shareLinkEnabled).toBe(false);
  });

  it("accessMode stays public_read — that label is visibility, not write ACL", () => {
    const payload = memoryPublishPayload(GTM_PREFS);
    expect(payload.visibility).toBe("public_read");
    expect(payload.linkPermission).toBe("read_write");
  });
});
