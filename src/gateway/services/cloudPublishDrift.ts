/**
 * Detect when local cloud-publish prefs diverge from memory server publish config.
 */

import type { RequiredKeySpec, ServiceCategory } from "../../core/types/bundles.js";
import type { CodeAccess } from "../../core/utils/shareAudienceModel.js";
import { catalogRequirementsForPublish } from "./cloudAppRequirements.js";
import type { CloudPublishAppPrefs } from "./cloudPublishPrefs.js";
import { isUninitializedSharingPrefs } from "./cloudPublishPrefs.js";
import {
  memoryPublishResponseToSharingSettings,
  resolvePublishFieldsFromPrefs,
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
  type CloudSharingSettings,
  type MemoryCatalogRequirementFields,
  type MemoryPublishResponseFields,
} from "./cloudPublishMapping.js";

export function slugifyPublishTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function prefsSharingFieldsChanged(
  update: Partial<CloudPublishAppPrefs>,
): boolean {
  return (
    update.accessMode !== undefined ||
    update.loginAccess !== undefined ||
    update.externalLink !== undefined ||
    update.codeAccess !== undefined ||
    update.requireSignIn !== undefined ||
    update.perUserIsolation !== undefined
  );
}

export interface PublishDriftInput {
  memory: MemoryPublishResponseFields | null;
  prefs: CloudPublishAppPrefs;
  expectedSlug: string;
  /** Effective local catalog (requirements.json + backend/manifest.json). */
  localCatalogRequirements?: RequiredKeySpec[];
  /** Local listing metadata from apps.json + platform manifest. */
  localCatalogMetadata?: {
    title?: string;
    description?: string;
    icon?: string;
    tags?: string[];
    platform?: string[];
    requiresDesktop?: boolean;
  };
}

function normalizedStringArray(values: string[] | undefined): string[] {
  return [...(values ?? [])].map((value) => value.trim()).filter(Boolean).sort();
}

function detectCatalogMetadataDrift(
  memory: MemoryPublishResponseFields,
  local: NonNullable<PublishDriftInput["localCatalogMetadata"]>,
): string[] {
  const reasons: string[] = [];

  if (local.title !== undefined && local.title !== (memory.catalogTitle ?? "")) {
    reasons.push("catalogTitle");
  }
  if (
    local.description !== undefined &&
    local.description !== (memory.catalogDescription ?? "")
  ) {
    reasons.push("catalogDescription");
  }
  if (local.icon !== undefined && local.icon !== (memory.catalogIcon ?? "")) {
    reasons.push("catalogIcon");
  }

  const localTags = normalizedStringArray(local.tags);
  const memoryTags = normalizedStringArray(memory.catalogTags);
  if (localTags.length > 0 && localTags.join("|") !== memoryTags.join("|")) {
    reasons.push("catalogTags");
  }

  const localPlatform = normalizedStringArray(local.platform);
  const memoryPlatform = normalizedStringArray(memory.catalogPlatform);
  if (
    localPlatform.length > 0 &&
    localPlatform.join("|") !== memoryPlatform.join("|")
  ) {
    reasons.push("catalogPlatform");
  }

  if (
    local.requiresDesktop !== undefined &&
    local.requiresDesktop !== (memory.catalogRequiresDesktop === true)
  ) {
    reasons.push("catalogRequiresDesktop");
  }

  return reasons;
}

function catalogDriftFingerprint(requirements: RequiredKeySpec[]): string {
  return JSON.stringify(
    catalogRequirementsForPublish(requirements)
      .map(({ name, credentialScope, clientAccess, required }) => ({
        name,
        credentialScope,
        clientAccess: clientAccess ?? "server",
        required,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

function memoryCatalogToRequiredKeySpecs(
  items: MemoryCatalogRequirementFields[] | null | undefined,
): RequiredKeySpec[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => ({
    name: item.name,
    service: item.service,
    category: (item.category as ServiceCategory) ?? "other",
    description: item.description ?? "",
    required: item.required !== false,
    credentialScope: item.credentialScope ?? "user",
    clientAccess: item.clientAccess ?? "server",
    ...(item.signupUrl ? { signupUrl: item.signupUrl } : {}),
    ...(item.docsUrl ? { docsUrl: item.docsUrl } : {}),
  }));
}

/**
 * Detect when local API key catalog diverges from the published cloud catalog.
 * Vault-resolve only injects keys registered at publish time.
 */
export function detectCatalogRequirementsDrift(
  localRequirements: RequiredKeySpec[],
  memory: MemoryPublishResponseFields | null,
  cachedFromLastPublish?: RequiredKeySpec[],
): string[] {
  if (!memory?.enabled) {
    return [];
  }

  let publishedRequirements: RequiredKeySpec[];
  if (Array.isArray(memory.catalogRequirements)) {
    publishedRequirements = memoryCatalogToRequiredKeySpecs(
      memory.catalogRequirements,
    );
  } else if (Array.isArray(cachedFromLastPublish)) {
    publishedRequirements = cachedFromLastPublish;
  } else if (localRequirements.length > 0) {
    return [
      `catalogKeys:+${localRequirements.map((spec) => spec.name).join(",")}`,
    ];
  } else {
    return [];
  }

  const localFingerprint = catalogDriftFingerprint(localRequirements);
  const publishedFingerprint = catalogDriftFingerprint(publishedRequirements);
  if (localFingerprint === publishedFingerprint) {
    return [];
  }

  const localNames = new Set(localRequirements.map((spec) => spec.name));
  const publishedNames = new Set(publishedRequirements.map((spec) => spec.name));
  const added = [...localNames].filter((name) => !publishedNames.has(name));
  const removed = [...publishedNames].filter((name) => !localNames.has(name));
  const reasons: string[] = [];
  if (added.length > 0) {
    reasons.push(`catalogKeys:+${added.join(",")}`);
  }
  if (removed.length > 0) {
    reasons.push(`catalogKeys:-${removed.join(",")}`);
  }
  if (added.length === 0 && removed.length === 0) {
    reasons.push("catalogKeys:metadata");
  }
  return reasons;
}

/**
 * Drift that should trigger automatic code/catalog republish only.
 * Sharing ACL changes require an explicit user or agent action.
 */
export function detectAutoPublishDrift(input: PublishDriftInput): string[] {
  const { memory, prefs, expectedSlug, localCatalogRequirements, localCatalogMetadata } =
    input;
  if (!memory?.enabled) {
    return [];
  }

  const reasons: string[] = [];

  if (memory.slug && memory.slug !== expectedSlug) {
    reasons.push(`slug:${memory.slug}→${expectedSlug}`);
  }

  if (localCatalogRequirements !== undefined) {
    reasons.push(
      ...detectCatalogRequirementsDrift(
        localCatalogRequirements,
        memory,
        prefs.credentialRequirements,
      ),
    );
  }

  if (localCatalogMetadata) {
    reasons.push(...detectCatalogMetadataDrift(memory, localCatalogMetadata));
  }

  return reasons;
}

/** UI display: local prefs when set; otherwise show what is live on cloud. Read-only. */
export function resolveSharingSettingsForDisplay(
  prefs: CloudPublishAppPrefs,
  memory: MemoryPublishResponseFields | null,
): CloudSharingSettings {
  if (memory?.enabled && isUninitializedSharingPrefs(prefs)) {
    return memoryPublishResponseToSharingSettings(memory);
  }
  return resolveSharingSettings(prefs);
}

export function detectPublishDrift(input: PublishDriftInput): string[] {
  const { memory, prefs, expectedSlug, localCatalogRequirements } = input;
  if (!memory?.enabled) {
    return [];
  }

  const reasons: string[] = [];
  const sharing = resolveSharingSettings(prefs);
  const desired = resolvePublishFieldsFromPrefs(prefs);

  if (memory.visibility !== desired.visibility) {
    reasons.push(`visibility:${memory.visibility ?? "none"}→${desired.visibility}`);
  }

  if (
    memory.linkPermission !== undefined &&
    memory.linkPermission !== desired.linkPermission
  ) {
    reasons.push(
      `linkPermission:${memory.linkPermission}→${desired.linkPermission}`,
    );
  }

  const localCode: CodeAccess = prefs.codeAccess ?? "off";
  const memoryCode: CodeAccess = memory.codeAccess ?? "off";
  if (localCode !== memoryCode) {
    reasons.push(`codeAccess:${memoryCode}→${localCode}`);
  }

  if (memory.slug && memory.slug !== expectedSlug) {
    reasons.push(`slug:${memory.slug}→${expectedSlug}`);
  }

  if (sharingSettingsRequireShareToken(sharing) && !memory.shareToken && !prefs.shareToken) {
    reasons.push("shareToken:missing");
  }

  const localRequireSignIn = desired.requireSignIn === true;
  const memoryRequireSignIn = memory.requireSignIn === true;
  if (localRequireSignIn !== memoryRequireSignIn) {
    reasons.push(
      `requireSignIn:${memoryRequireSignIn ? "true" : "false"}→${localRequireSignIn ? "true" : "false"}`,
    );
  }

  if (localCatalogRequirements !== undefined) {
    reasons.push(
      ...detectCatalogRequirementsDrift(
        localCatalogRequirements,
        memory,
        prefs.credentialRequirements,
      ),
    );
  }

  return reasons;
}

/** Cached share token is only valid when cloud publish config matches local prefs. */
export function resolveShareTokenForConfig(
  memory: MemoryPublishResponseFields | null,
  prefs: CloudPublishAppPrefs,
  expectedSlug: string,
): string | null {
  if (memory?.shareToken) {
    return memory.shareToken;
  }
  const drift = detectPublishDrift({ memory, prefs, expectedSlug });
  if (drift.length > 0) {
    return null;
  }
  return prefs.shareToken ?? null;
}
