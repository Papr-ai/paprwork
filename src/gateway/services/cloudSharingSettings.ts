/**
 * Multi-option cloud sharing — Papr login access + optional external link.
 */

import {
  audienceModelToSharing,
  liveLinkPermissionForAudienceModel,
  sharingToAudienceModel,
  type ShareAudienceModel,
} from "../../core/utils/shareAudienceModel.js";
import type { CloudAccessMode, CloudPublishAppPrefs } from "./cloudPublishPrefs.js";

export type CloudLoginAccess = "private" | "team" | "public" | "none";
export type CloudExternalLink = "off" | "read" | "read_write";

export interface CloudSharingSettings {
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
}

export interface MemoryPublishSharingFields {
  visibility: CloudAccessMode;
  linkPermission: "read" | "read_write";
  shareLinkEnabled: boolean;
  requireSignIn?: boolean;
}

const LOGIN_ACCESS_MODES: readonly CloudLoginAccess[] = [
  "private",
  "team",
  "public",
  "none",
];

const EXTERNAL_LINK_MODES: readonly CloudExternalLink[] = [
  "off",
  "read",
  "read_write",
];

export function normalizeLoginAccess(value: string | undefined): CloudLoginAccess {
  if (value && LOGIN_ACCESS_MODES.includes(value as CloudLoginAccess)) {
    return value as CloudLoginAccess;
  }
  return "private";
}

export function normalizeExternalLink(value: string | undefined): CloudExternalLink {
  if (value && EXTERNAL_LINK_MODES.includes(value as CloudExternalLink)) {
    return value as CloudExternalLink;
  }
  return "off";
}

export function accessModeToSharingSettings(
  accessMode: CloudAccessMode,
): CloudSharingSettings {
  switch (accessMode) {
    case "team":
      return { loginAccess: "team", externalLink: "off" };
    case "public_read":
      return { loginAccess: "public", externalLink: "off" };
    case "link_read":
      return { loginAccess: "none", externalLink: "read" };
    case "link_read_write":
      return { loginAccess: "none", externalLink: "read_write" };
    case "private":
    default:
      return { loginAccess: "private", externalLink: "off" };
  }
}

export function sharingSettingsToAccessMode(
  settings: CloudSharingSettings,
): CloudAccessMode {
  if (settings.externalLink !== "off") {
    if (settings.loginAccess === "team") {
      return "team";
    }
    return settings.externalLink === "read_write" ? "link_read_write" : "link_read";
  }
  if (settings.loginAccess === "public") {
    return "public_read";
  }
  if (settings.loginAccess === "team") {
    return "team";
  }
  return "private";
}

export function audienceModelToPublishFields(
  model: ShareAudienceModel,
  actualSharing?: CloudSharingSettings,
): MemoryPublishSharingFields {
  const sharing = audienceModelToSharing(model);
  const externalLink = actualSharing?.externalLink ?? sharing.externalLink;
  const shareLinkEnabled = externalLink !== "off";

  if (model.audience === "link") {
    const linkPermission = liveLinkPermissionForAudienceModel(model);
    const loginAccess = actualSharing?.loginAccess ?? sharing.loginAccess;
    const linkVisibility =
      linkPermission === "read_write" ? "link_read_write" : "link_read";
    if (loginAccess === "team") {
      return {
        visibility: "team",
        linkPermission,
        shareLinkEnabled: externalLink !== "off",
      };
    }
    return {
      visibility: linkVisibility,
      linkPermission,
      shareLinkEnabled: true,
      ...(model.requireSignIn !== false ? { requireSignIn: true } : {}),
    };
  }

  const linkPermission = liveLinkPermissionForAudienceModel(model);

  if (model.audience === "public") {
    return {
      visibility: "public_read",
      linkPermission,
      shareLinkEnabled,
      ...(model.requireSignIn === true ? { requireSignIn: true } : {}),
    };
  }

  if (model.audience === "team") {
    return {
      visibility: "team",
      linkPermission,
      shareLinkEnabled,
    };
  }

  return sharingSettingsToPublishFields({
    loginAccess: sharing.loginAccess,
    externalLink,
  });
}

export function resolvePublishFieldsFromPrefs(
  prefs: Pick<
    CloudPublishAppPrefs,
    | "loginAccess"
    | "externalLink"
    | "accessMode"
    | "codeAccess"
    | "requireSignIn"
  >,
): MemoryPublishSharingFields {
  const sharing = resolveSharingSettings(prefs);
  const model = sharingToAudienceModel(
    sharing.loginAccess,
    sharing.externalLink,
    prefs.codeAccess ?? "off",
    {
      requireSignIn: prefs.requireSignIn,
    },
  );
  return audienceModelToPublishFields(model, sharing);
}

export function sharingSettingsToPublishFields(
  settings: CloudSharingSettings,
): MemoryPublishSharingFields {
  const linkPermission =
    settings.externalLink === "read_write" ? "read_write" : "read";
  const shareLinkEnabled = settings.externalLink !== "off";

  if (settings.externalLink !== "off" && settings.loginAccess === "none") {
    return {
      visibility:
        settings.externalLink === "read_write" ? "link_read_write" : "link_read",
      linkPermission,
      shareLinkEnabled: true,
    };
  }

  if (settings.loginAccess === "public" || settings.loginAccess === "team") {
    const model = sharingToAudienceModel(
      settings.loginAccess,
      settings.externalLink,
      "off",
    );
    return audienceModelToPublishFields(model, settings);
  }

  return {
    visibility: "private",
    linkPermission: "read_write",
    shareLinkEnabled,
  };
}

export function sharingSettingsRequireShareToken(
  settings: CloudSharingSettings,
): boolean {
  return settings.externalLink !== "off";
}

export function loginAccessRequiresPaprLogin(
  loginAccess: CloudLoginAccess,
): boolean {
  return loginAccess === "private" || loginAccess === "team";
}

export function resolveSharingSettings(input: {
  loginAccess?: CloudLoginAccess;
  externalLink?: CloudExternalLink;
  accessMode?: CloudAccessMode;
  shareToken?: string;
}): CloudSharingSettings {
  if (input.loginAccess !== undefined || input.externalLink !== undefined) {
    return {
      loginAccess: normalizeLoginAccess(input.loginAccess),
      externalLink: normalizeExternalLink(input.externalLink),
    };
  }
  const fromAccessMode = accessModeToSharingSettings(input.accessMode ?? "private");
  if (
    input.accessMode === "public_read" &&
    input.shareToken?.trim() &&
    fromAccessMode.externalLink === "off"
  ) {
    return { loginAccess: "public", externalLink: "read" };
  }
  return fromAccessMode;
}

export function sharingSettingsSummary(settings: CloudSharingSettings): string {
  const loginLabels: Record<CloudLoginAccess, string> = {
    private: "Private (you)",
    team: "Team",
    public: "Public",
    none: "No Papr login",
  };
  const linkLabels: Record<CloudExternalLink, string> = {
    off: "No external link",
    read: "External read link",
    read_write: "External read/write link",
  };
  return `${loginLabels[settings.loginAccess]} · ${linkLabels[settings.externalLink]}`;
}
