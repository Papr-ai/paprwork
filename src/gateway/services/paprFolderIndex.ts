/**
 * Index job/app folders across flat ~/Papr and all org/namespace workspaces.
 * Used by legacy path health scan to detect missing resources and find copies elsewhere.
 */

import { existsSync, type Dirent } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprBaseDir } from "../../core/utils/paprWorkspace.js";

export interface IndexedJobFolder {
  jobId: string;
  jobDir: string;
  workspaceHome: string;
  orgId?: string;
  namespaceId?: string;
}

export interface IndexedAppFolder {
  appId: string;
  appPath: string;
  workspaceHome: string;
  orgId?: string;
  namespaceId?: string;
}

function parseNamespaceWorkspaceHome(
  paprBase: string,
  workspaceHome: string,
): { orgId?: string; namespaceId?: string } {
  const rel = path.relative(paprBase, workspaceHome);
  const segments = rel.split(path.sep);
  if (
    segments.length >= 4 &&
    segments[0] === "orgs" &&
    segments[2] === "namespaces"
  ) {
    return { orgId: segments[1], namespaceId: segments[3] };
  }
  return {};
}

async function indexJobFoldersInRoot(
  jobsRoot: string,
  workspaceHome: string,
  index: Map<string, IndexedJobFolder>,
  paprBase: string,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(jobsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const ns = parseNamespaceWorkspaceHome(paprBase, workspaceHome);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(jobsRoot, entry.name);
    if (!existsSync(jobDir)) continue;
    index.set(entry.name, {
      jobId: entry.name,
      jobDir,
      workspaceHome,
      ...ns,
    });
  }
}

async function indexAppFoldersInRoot(
  appsRoot: string,
  workspaceHome: string,
  index: Map<string, IndexedAppFolder>,
  paprBase: string,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(appsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const ns = parseNamespaceWorkspaceHome(paprBase, workspaceHome);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appPath = path.join(appsRoot, entry.name);
    const hasIndex = existsSync(path.join(appPath, "index.html"));
    const hasDataSources = existsSync(path.join(appPath, "data-sources.json"));
    if (!hasIndex && !hasDataSources) continue;
    index.set(entry.name, {
      appId: entry.name,
      appPath,
      workspaceHome,
      ...ns,
    });
  }
}

export async function buildJobFolderIndex(
  paprBase: string = getPaprBaseDir(),
): Promise<Map<string, IndexedJobFolder>> {
  const index = new Map<string, IndexedJobFolder>();

  await indexJobFoldersInRoot(
    path.join(paprBase, "Jobs"),
    paprBase,
    index,
    paprBase,
  );
  await indexJobFoldersInRoot(
    path.join(paprBase, "jobs"),
    paprBase,
    index,
    paprBase,
  );

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return index;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      const workspaceHome = path.join(namespacesDir, namespaceId);
      await indexJobFoldersInRoot(
        path.join(workspaceHome, "Jobs"),
        workspaceHome,
        index,
        paprBase,
      );
    }
  }

  return index;
}

export async function buildAppFolderIndex(
  paprBase: string = getPaprBaseDir(),
): Promise<Map<string, IndexedAppFolder>> {
  const index = new Map<string, IndexedAppFolder>();

  await indexAppFoldersInRoot(
    path.join(paprBase, "apps"),
    paprBase,
    index,
    paprBase,
  );

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return index;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      const workspaceHome = path.join(namespacesDir, namespaceId);
      await indexAppFoldersInRoot(
        path.join(workspaceHome, "apps"),
        workspaceHome,
        index,
        paprBase,
      );
    }
  }

  return index;
}

export function formatIndexedLocation(entry: {
  workspaceHome: string;
  orgId?: string;
  namespaceId?: string;
}): string {
  if (entry.orgId && entry.namespaceId) {
    return `org ${entry.orgId} / namespace ${entry.namespaceId} (${entry.workspaceHome})`;
  }
  return `flat Papr root (${entry.workspaceHome})`;
}
