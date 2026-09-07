/**
 * Org/namespace scoping for mini-apps — My Apps only lists apps assigned to the active workspace.
 */

import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_BUNDLED_APP_IDS } from "./paprWorkspace.js";
import {
  parseCloudAppMetadataFile,
  type CloudAppMetadataFile,
} from "./cloudAppMetadata.js";
import { readActiveWorkspacePointer } from "./paprWorkspace.js";

export interface AppWorkspaceScope {
  organizationId: string;
  namespaceId: string;
}

export interface AppWorkspaceFields {
  organizationId?: string;
  namespaceId?: string;
}

export function readActiveAppWorkspaceScope(): AppWorkspaceScope | null {
  const pointer = readActiveWorkspacePointer();
  const organizationId = pointer?.organizationId?.trim();
  const namespaceId = pointer?.namespaceId?.trim();
  if (!organizationId || !namespaceId) {
    return null;
  }
  return { organizationId, namespaceId };
}

export function isAppWorkspaceUnassigned(fields: AppWorkspaceFields): boolean {
  return !fields.organizationId?.trim() || !fields.namespaceId?.trim();
}

export function isAppAssignedToWorkspace(
  fields: AppWorkspaceFields,
  scope: AppWorkspaceScope,
): boolean {
  return (
    fields.organizationId?.trim() === scope.organizationId &&
    fields.namespaceId?.trim() === scope.namespaceId
  );
}

export function isBundledDefaultAppId(appId: string): boolean {
  return DEFAULT_BUNDLED_APP_IDS.has(appId);
}

/** Bundled defaults (Home) always belong to the workspace where they are installed. */
export function shouldShowAppInMyApps(
  appId: string,
  fields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope | null,
): boolean {
  if (isBundledDefaultAppId(appId)) {
    return true;
  }
  if (!activeScope) {
    return true;
  }
  if (isAppWorkspaceUnassigned(fields)) {
    return false;
  }
  return isAppAssignedToWorkspace(fields, activeScope);
}

/** App folder exists in this namespace but is not assigned here (unassigned or assigned elsewhere). */
export function isAppUnassignedInActiveWorkspace(
  appId: string,
  fields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope | null,
): boolean {
  if (!activeScope || isBundledDefaultAppId(appId)) {
    return false;
  }
  return !shouldShowAppInMyApps(appId, fields, activeScope);
}

/**
 * Apps that need assignment in the active workspace (missing org/namespace only).
 * Apps already assigned to another workspace are excluded — they belong there.
 */
export function isAppAwaitingAssignmentInWorkspace(
  appId: string,
  fields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope | null,
): boolean {
  if (!activeScope || isBundledDefaultAppId(appId)) {
    return false;
  }
  if (!isAppWorkspaceUnassigned(fields)) {
    return false;
  }
  return true;
}

export function mergeAppWorkspaceFields(
  indexFields: AppWorkspaceFields,
  diskFields: AppWorkspaceFields,
): AppWorkspaceFields {
  return {
    organizationId:
      diskFields.organizationId?.trim() || indexFields.organizationId?.trim(),
    namespaceId:
      diskFields.namespaceId?.trim() || indexFields.namespaceId?.trim(),
  };
}

export async function readAppWorkspaceFieldsFromDisk(
  appDir: string,
): Promise<AppWorkspaceFields> {
  try {
    const raw = await fs.readFile(path.join(appDir, "metadata.json"), "utf8");
    const metadata = parseCloudAppMetadataFile(raw);
    if (!metadata) {
      return {};
    }
    return workspaceFieldsFromMetadata(metadata);
  } catch {
    return {};
  }
}

export function workspaceFieldsFromMetadata(
  metadata: CloudAppMetadataFile,
): AppWorkspaceFields {
  return {
    ...(metadata.organizationId ? { organizationId: metadata.organizationId.trim() } : {}),
    ...(metadata.namespaceId ? { namespaceId: metadata.namespaceId.trim() } : {}),
  };
}

export function withWorkspaceScope<T extends AppWorkspaceFields>(
  app: T,
  scope: AppWorkspaceScope,
): T {
  return {
    ...app,
    organizationId: scope.organizationId,
    namespaceId: scope.namespaceId,
  };
}

/**
 * Whether pruneStrayWorkspaceAppCopies may delete an app folder.
 * apps.json is authoritative — never prune apps registered in the active workspace,
 * even when cloud-pulled metadata.json claims a different org/namespace.
 */
export function shouldPruneStrayWorkspaceAppCopy(
  indexFields: AppWorkspaceFields,
  diskFields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope,
): boolean {
  if (isAppAssignedToWorkspace(indexFields, activeScope)) {
    return false;
  }

  const merged = mergeAppWorkspaceFields(indexFields, diskFields);
  if (isAppWorkspaceUnassigned(merged)) {
    return false;
  }
  return !isAppAssignedToWorkspace(merged, activeScope);
}

/**
 * Resolve which org/namespace Get updates should write into metadata.json.
 * Home path (active workspace) wins over stale cloud repo assignment.
 */
export function resolveWorkspaceScopeForPulledMetadata(
  localIndexFields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope | null,
): AppWorkspaceScope | null {
  if (!activeScope) {
    return null;
  }
  if (isAppAssignedToWorkspace(localIndexFields, activeScope)) {
    return {
      organizationId: localIndexFields.organizationId!.trim(),
      namespaceId: localIndexFields.namespaceId!.trim(),
    };
  }
  if (!isAppWorkspaceUnassigned(localIndexFields)) {
    // Index explicitly belongs to another workspace — do not re-home via pull.
    return null;
  }
  // App folder lives in this home path; stamp the active workspace.
  return activeScope;
}

export interface PulledMetadataScopeRepair {
  content: string;
  appliedScope: AppWorkspaceScope | null;
  repaired: boolean;
}

/**
 * Get updates must not overwrite local workspace assignment with stale cloud metadata
 * (e.g. bundle import source namespace baked into the per-app repo).
 */
export function repairPulledMetadataWorkspaceScope(
  pulledContent: string,
  localIndexFields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope | null,
): PulledMetadataScopeRepair {
  if (!activeScope) {
    return { content: pulledContent, appliedScope: null, repaired: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(pulledContent) as Record<string, unknown>;
  } catch {
    return { content: pulledContent, appliedScope: null, repaired: false };
  }

  const targetScope = resolveWorkspaceScopeForPulledMetadata(
    localIndexFields,
    activeScope,
  );

  const pulledOrg =
    typeof parsed.organizationId === "string" ? parsed.organizationId.trim() : "";
  const pulledNs =
    typeof parsed.namespaceId === "string" ? parsed.namespaceId.trim() : "";

  if (!targetScope) {
    const pulledAssignedElsewhere =
      pulledOrg.length > 0 &&
      pulledNs.length > 0 &&
      !isAppAssignedToWorkspace(
        { organizationId: pulledOrg, namespaceId: pulledNs },
        activeScope,
      );
    if (!pulledAssignedElsewhere) {
      return { content: pulledContent, appliedScope: null, repaired: false };
    }
    delete parsed.organizationId;
    delete parsed.namespaceId;
    return {
      content: `${JSON.stringify(parsed, null, 2)}\n`,
      appliedScope: null,
      repaired: true,
    };
  }

  const repaired =
    pulledOrg !== targetScope.organizationId || pulledNs !== targetScope.namespaceId;
  parsed.organizationId = targetScope.organizationId;
  parsed.namespaceId = targetScope.namespaceId;
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    appliedScope: targetScope,
    repaired,
  };
}

/** @deprecated Use repairPulledMetadataWorkspaceScope — kept for callers that only need content. */
export function preserveLocalWorkspaceScopeInPulledMetadata(
  pulledContent: string,
  localIndexFields: AppWorkspaceFields,
  activeScope: AppWorkspaceScope | null,
): string {
  return repairPulledMetadataWorkspaceScope(
    pulledContent,
    localIndexFields,
    activeScope,
  ).content;
}
