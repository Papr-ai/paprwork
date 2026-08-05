/**
 * Maps Paprwork cloud link prefs ↔ memory server publish API fields.
 */

import type { CloudAccessMode } from "./cloudPublishPrefs.js";
import { formatShareLink } from "../../core/utils/cloudShareLink.js";
import {
  accessModeToSharingSettings,
  sharingSettingsToPublishFields,
  type CloudSharingSettings,
} from "./cloudSharingSettings.js";

export { formatShareLink, accessModeRequiresShareToken } from "../../core/utils/cloudShareLink.js";
export {
  accessModeToSharingSettings,
  sharingSettingsRequireShareToken,
  sharingSettingsToPublishFields,
  resolveSharingSettings,
  resolvePublishFieldsFromPrefs,
  sharingSettingsSummary,
  type CloudSharingSettings,
  type CloudLoginAccess,
  type CloudExternalLink,
} from "./cloudSharingSettings.js";

export interface MemoryCatalogRequirementFields {
  name: string;
  service: string;
  category: string;
  description: string;
  required: boolean;
  credentialScope: "owner" | "user";
  clientAccess?: "server" | "client";
  signupUrl?: string;
  docsUrl?: string;
}

export interface MemoryPublishRequestFields {
  visibility: CloudAccessMode;
  linkPermission: "read" | "read_write";
  shareLinkEnabled: boolean;
  codeAccess?: "off" | "install";
  catalogRequirements?: MemoryCatalogRequirementFields[];
}

export interface MemoryPublishResponseFields {
  appId?: string;
  slug?: string;
  visibility?: string;
  linkPermission?: string;
  codeAccess?: "off" | "install";
  enabled?: boolean;
  shareUrl?: string;
  shareToken?: string;
  publishedAt?: string;
  catalogRequirements?: MemoryCatalogRequirementFields[];
}

const ACCESS_MODES: readonly CloudAccessMode[] = [
  "private",
  "team",
  "link_read",
  "link_read_write",
  "public_read",
];

export function accessModeToPublishFields(
  accessMode: CloudAccessMode,
): MemoryPublishRequestFields {
  return sharingSettingsToPublishFields(accessModeToSharingSettings(accessMode));
}

export function sharingSettingsToMemoryPublishFields(
  settings: CloudSharingSettings,
): MemoryPublishRequestFields {
  return sharingSettingsToPublishFields(settings);
}

export function visibilityToAccessMode(visibility: string | undefined): CloudAccessMode {
  if (visibility && ACCESS_MODES.includes(visibility as CloudAccessMode)) {
    return visibility as CloudAccessMode;
  }
  return "private";
}

export function memoryPublishResponseToConfig(
  appId: string,
  data: MemoryPublishResponseFields | null,
): {
  appId: string;
  slug: string | null;
  accessMode: CloudAccessMode;
  enabled: boolean;
  shareUrl: string | null;
  publishedAt: string | null;
  shareToken?: string | null;
} {
  if (!data || data.enabled === false) {
    return {
      appId,
      slug: data?.slug ?? null,
      accessMode: visibilityToAccessMode(data?.visibility),
      enabled: false,
      shareUrl: data?.shareUrl ?? null,
      publishedAt: data?.publishedAt ?? null,
    };
  }
  return {
    appId,
    slug: data.slug ?? null,
    accessMode: visibilityToAccessMode(data.visibility),
    enabled: true,
    shareUrl: formatShareLink(data.shareUrl ?? null, data.shareToken, data.visibility) ?? data.shareUrl ?? null,
    publishedAt: data.publishedAt ?? null,
    shareToken: data.shareToken ?? null,
  };
}
