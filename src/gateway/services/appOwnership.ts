/**
 * Mini-app ownership — My Apps must only include apps owned by the signed-in user.
 * Team-shared apps belong in the Team Apps catalog (memory server), not local index.
 */

import { promises as fs } from "fs";
import path from "path";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import { parseCloudAppMetadataFile } from "../../core/utils/cloudAppMetadata.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import { CLOUD_LINEAGE_FILENAME } from "./CloudAppLineageService.js";
import type { MiniApp } from "./AppService.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";

export interface AppDiskOwnershipHints {
  metadataOwnerUserId?: string;
  lineageSourceAppId?: string;
  lineagePublisherUserId?: string;
  /** Local copy is an install fork (new app id, tracks upstream). */
  isInstalledFork: boolean;
}

export interface ForeignAppIndexEntry {
  appId: string;
  publisherUserId: string;
}

interface TeamCatalogApiEntry {
  appId?: string;
  publisherUserId?: string;
}

interface TeamCatalogApiResponse {
  apps?: TeamCatalogApiEntry[];
}

/** Read ownership signals from disk (metadata.json + papr-cloud-lineage.json). */
export async function readAppDiskOwnershipHints(
  appDir: string,
  localAppId: string,
): Promise<AppDiskOwnershipHints> {
  const hints: AppDiskOwnershipHints = { isInstalledFork: false };

  try {
    const raw = await fs.readFile(path.join(appDir, "metadata.json"), "utf-8");
    const metadata = parseCloudAppMetadataFile(raw);
    if (metadata?.ownerUserId) {
      hints.metadataOwnerUserId = metadata.ownerUserId;
    }
  } catch {
    /* optional */
  }

  try {
    const raw = await fs.readFile(
      path.join(appDir, CLOUD_LINEAGE_FILENAME),
      "utf-8",
    );
    const lineage = parseCloudAppLineageFile(raw);
    if (lineage) {
      hints.lineageSourceAppId = lineage.source.appId;
      hints.lineagePublisherUserId = lineage.source.userId;
      hints.isInstalledFork = localAppId !== lineage.source.appId;
    }
  } catch {
    /* optional */
  }

  return hints;
}

/** True when the signed-in user may see/edit this app in My Apps. */
export function isAppOwnedByCurrentUser(
  app: MiniApp,
  hints?: AppDiskOwnershipHints,
): boolean {
  const currentUserId = getPaprUserId()?.trim();
  if (!currentUserId) {
    // Open-source / offline: hide entries explicitly owned by another Papr user.
    if (app.ownerUserId) {
      return false;
    }
    if (hints?.metadataOwnerUserId) {
      return false;
    }
    return true;
  }

  if (app.ownerUserId) {
    return app.ownerUserId === currentUserId;
  }

  if (hints?.isInstalledFork) {
    return true;
  }

  if (
    hints?.metadataOwnerUserId &&
    hints.metadataOwnerUserId !== currentUserId
  ) {
    return false;
  }

  if (
    hints?.lineagePublisherUserId &&
    hints.lineageSourceAppId === app.id &&
    hints.lineagePublisherUserId !== currentUserId
  ) {
    return false;
  }

  return true;
}

/** Team catalog entries published by someone else (same appId on shared disk). */
export async function fetchForeignPublisherAppIds(
  namespaceId: string,
): Promise<Map<string, string>> {
  const currentUserId = getPaprUserId()?.trim();
  if (!currentUserId) {
    return new Map();
  }

  const query = `?namespaceId=${encodeURIComponent(namespaceId)}`;
  const paths = [
    `/v1/cloud/apps/shared-with-me${query}`,
    `/v1/cloud/apps/team${query}`,
  ];
  const foreign = new Map<string, string>();

  for (const cloudPath of paths) {
    try {
      const response = await cloudApiFetch(cloudPath, { timeoutMs: 15_000 });
      if (!response.ok) continue;
      const body = (await response.json()) as TeamCatalogApiResponse;
      for (const entry of body.apps ?? []) {
        const appId = entry.appId?.trim();
        const publisherUserId = entry.publisherUserId?.trim();
        if (!appId || !publisherUserId || publisherUserId === currentUserId) {
          continue;
        }
        foreign.set(appId, publisherUserId);
      }
    } catch {
      /* catalog optional during offline startup */
    }
  }

  return foreign;
}

export function resolveActiveNamespaceId(): string | undefined {
  const pointer = readActiveWorkspacePointer();
  return pointer?.namespaceId?.trim() || undefined;
}

/** Decide whether a disk folder should be indexed for the current user. */
export async function shouldIndexAppFolderForCurrentUser(
  appId: string,
  appDir: string,
  foreignPublisherAppIds: Map<string, string>,
): Promise<boolean> {
  const hints = await readAppDiskOwnershipHints(appDir, appId);
  const stub: MiniApp = {
    id: appId,
    title: appId,
    description: "",
    type: "app",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const publisherFromCatalog = foreignPublisherAppIds.get(appId);
  if (publisherFromCatalog) {
    const currentUserId = getPaprUserId()?.trim();
    const hasLocalOwnershipProof =
      hints.isInstalledFork ||
      Boolean(
        currentUserId &&
          hints.metadataOwnerUserId &&
          hints.metadataOwnerUserId === currentUserId,
      );
    if (!hasLocalOwnershipProof) {
      return false;
    }
  }

  return isAppOwnedByCurrentUser(stub, hints);
}

export function loadOwnedLocalAppIdsFromIndex(
  apps: Iterable<MiniApp>,
): Set<string> {
  const owned = new Set<string>();
  for (const app of apps) {
    if (isAppOwnedByCurrentUser(app)) {
      owned.add(app.id);
    }
  }
  return owned;
}
