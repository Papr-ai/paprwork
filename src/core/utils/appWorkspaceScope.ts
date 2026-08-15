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
