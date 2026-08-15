/**
 * Assign mini-apps to a specific org/namespace and remove stray unassigned copies.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  isAppWorkspaceUnassigned,
  type AppWorkspaceScope,
  withWorkspaceScope,
} from "../../core/utils/appWorkspaceScope.js";
import {
  getPaprBaseDir,
  resolveOrgNamespaceWorkspacePath,
} from "../../core/utils/paprWorkspace.js";
import type { MiniApp } from "./AppService.js";
import {
  copyAppToNamespace,
  CopyAppError,
  syncAppLinkedResourcesToTarget,
  finalizeCopiedAppResources,
  type CopyAppToNamespaceInput,
} from "./copyAppToNamespace.js";
import { writeCloudAppMetadataFile } from "./cloudAppMetadataFile.js";

export class AppWorkspaceAssignError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppWorkspaceAssignError";
    this.code = code;
  }
}

async function readAppsIndex(indexPath: string): Promise<MiniApp[]> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as MiniApp[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAppsIndex(indexPath: string, apps: MiniApp[]): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(apps, null, 2), "utf8");
  await fs.rename(tmpPath, indexPath);
}

async function listNamespaceWorkspaceHomes(): Promise<string[]> {
  const orgsRoot = path.join(getPaprBaseDir(), "orgs");
  const homes: string[] = [];

  let orgIds: string[] = [];
  try {
    orgIds = await fs.readdir(orgsRoot);
  } catch {
    return homes;
  }

  for (const orgId of orgIds) {
    if (orgId.startsWith(".")) {
      continue;
    }
    const namespacesRoot = path.join(orgsRoot, orgId, "namespaces");
    let namespaceIds: string[] = [];
    try {
      namespaceIds = await fs.readdir(namespacesRoot);
    } catch {
      continue;
    }
    for (const namespaceId of namespaceIds) {
      if (namespaceId.startsWith(".")) {
        continue;
      }
      homes.push(path.join(namespacesRoot, namespaceId));
    }
  }

  return homes;
}

async function appDirHasRunnableBundle(appDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(appDir, "index.html"));
    return true;
  } catch {
    try {
      await fs.access(path.join(appDir, "dist", "app.js"));
      return true;
    } catch {
      return false;
    }
  }
}

async function resolveSourcePaprHomeForApp(
  appId: string,
  declaredSourceHome: string,
): Promise<string> {
  const declaredAppDir = path.join(declaredSourceHome, "apps", appId);
  if (await appDirHasRunnableBundle(declaredAppDir)) {
    return declaredSourceHome;
  }

  const flatHome = getPaprBaseDir();
  if (path.normalize(flatHome) !== path.normalize(declaredSourceHome)) {
    const flatAppDir = path.join(flatHome, "apps", appId);
    if (await appDirHasRunnableBundle(flatAppDir)) {
      return flatHome;
    }
  }

  for (const home of await listNamespaceWorkspaceHomes()) {
    if (path.normalize(home) === path.normalize(declaredSourceHome)) {
      continue;
    }
    const appDir = path.join(home, "apps", appId);
    if (await appDirHasRunnableBundle(appDir)) {
      return home;
    }
  }

  return declaredSourceHome;
}

async function copyAppBundleIntoTarget(
  sourceHome: string,
  targetHome: string,
  appId: string,
): Promise<boolean> {
  const sourceAppDir = path.join(sourceHome, "apps", appId);
  const targetAppDir = path.join(targetHome, "apps", appId);

  if (!(await appDirHasRunnableBundle(sourceAppDir))) {
    return false;
  }

  await fs.mkdir(path.dirname(targetAppDir), { recursive: true });
  if (path.normalize(sourceAppDir) === path.normalize(targetAppDir)) {
    return true;
  }

  const targetHasBundle = await appDirHasRunnableBundle(targetAppDir);
  if (!targetHasBundle) {
    await fs.cp(sourceAppDir, targetAppDir, { recursive: true, force: true });
    return appDirHasRunnableBundle(targetAppDir);
  }

  return true;
}

async function copyAppBundleAndLinkedResources(
  sourceHome: string,
  targetHome: string,
  appId: string,
): Promise<void> {
  if (path.normalize(sourceHome) !== path.normalize(targetHome)) {
    const targetAppDir = path.join(targetHome, "apps", appId);
    if (!(await appDirHasRunnableBundle(targetAppDir))) {
      await copyAppBundleIntoTarget(sourceHome, targetHome, appId);
    }
    const sync = await syncAppLinkedResourcesToTarget({
      appId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
    });
    await finalizeCopiedAppResources({
      targetPaprHome: targetHome,
      appId,
      copiedJobIds: sync.copiedJobIds,
      registryDbIds: sync.registryDbIds,
    });
    return;
  }

  await copyAppBundleIntoTarget(sourceHome, targetHome, appId);
}

async function removeAppFromNamespaceHome(
  paprHome: string,
  appId: string,
): Promise<boolean> {
  const appDir = path.join(paprHome, "apps", appId);
  const indexPath = path.join(paprHome, "data", "apps.json");
  let removed = false;

  try {
    await fs.access(appDir);
    await fs.rm(appDir, { recursive: true, force: true });
    removed = true;
  } catch {
    /* no folder */
  }

  const apps = await readAppsIndex(indexPath);
  const nextApps = apps.filter((entry) => entry.id !== appId);
  if (nextApps.length !== apps.length) {
    await writeAppsIndex(indexPath, nextApps);
    removed = true;
  }

  return removed;
}

/**
 * After assigning to a canonical workspace, drop unassigned duplicate folders in other namespaces.
 * If the canonical folder only has registry metadata, merge runnable bundles from duplicates first.
 */
export async function removeUnassignedDuplicateAppCopies(
  appId: string,
  canonical: AppWorkspaceScope,
): Promise<string[]> {
  const canonicalHome = resolveOrgNamespaceWorkspacePath(
    canonical.organizationId,
    canonical.namespaceId,
  );
  const removedFrom: string[] = [];
  const canonicalAppDir = path.join(canonicalHome, "apps", appId);

  for (const paprHome of await listNamespaceWorkspaceHomes()) {
    if (path.normalize(paprHome) === path.normalize(canonicalHome)) {
      continue;
    }

    const indexPath = path.join(paprHome, "data", "apps.json");
    const apps = await readAppsIndex(indexPath);
    const entry = apps.find((app) => app.id === appId);
    const appDir = path.join(paprHome, "apps", appId);

    let hasDir = false;
    try {
      await fs.access(appDir);
      hasDir = true;
    } catch {
      /* missing */
    }

    if (!entry && !hasDir) {
      continue;
    }

    const duplicateHasBundle = hasDir && (await appDirHasRunnableBundle(appDir));
    const canonicalHasBundle = await appDirHasRunnableBundle(canonicalAppDir);

    if (duplicateHasBundle && !canonicalHasBundle) {
      await copyAppBundleAndLinkedResources(paprHome, canonicalHome, appId);
      if (await removeAppFromNamespaceHome(paprHome, appId)) {
        removedFrom.push(paprHome);
      }
      continue;
    }

    const unassigned =
      !entry ||
      isAppWorkspaceUnassigned(entry) ||
      entry.organizationId !== canonical.organizationId ||
      entry.namespaceId !== canonical.namespaceId;

    if (!unassigned) {
      continue;
    }

    if (duplicateHasBundle && !canonicalHasBundle) {
      continue;
    }

    if (await removeAppFromNamespaceHome(paprHome, appId)) {
      removedFrom.push(paprHome);
    }
  }

  return removedFrom;
}

export interface AssignAppToWorkspaceInput {
  appId: string;
  targetOrganizationId: string;
  targetNamespaceId: string;
  sourcePaprHome: string;
  sourceApp: MiniApp;
}

export interface AssignAppToWorkspaceResult {
  action: "assigned" | "moved";
  organizationId: string;
  namespaceId: string;
  removedDuplicateHomes: string[];
}

async function ensureTargetHasAppBundle(input: {
  appId: string;
  targetHome: string;
  sourceHome: string;
}): Promise<void> {
  const targetAppDir = path.join(input.targetHome, "apps", input.appId);
  const effectiveSourceHome = await resolveSourcePaprHomeForApp(
    input.appId,
    input.sourceHome,
  );

  if (!(await appDirHasRunnableBundle(targetAppDir))) {
    await copyAppBundleIntoTarget(
      effectiveSourceHome,
      input.targetHome,
      input.appId,
    );
  }

  if (!(await appDirHasRunnableBundle(targetAppDir))) {
    throw new AppWorkspaceAssignError(
      "app_files_missing",
      "App registry was updated but the app files could not be found to move.",
    );
  }

  if (path.normalize(effectiveSourceHome) !== path.normalize(input.targetHome)) {
    await syncAppLinkedResourcesToTarget({
      appId: input.appId,
      sourcePaprHome: effectiveSourceHome,
      targetPaprHome: input.targetHome,
    });
  }
}

async function updateAssignedAppIndex(
  paprHome: string,
  input: AssignAppToWorkspaceInput,
  scope: AppWorkspaceScope,
): Promise<void> {
  const indexPath = path.join(paprHome, "data", "apps.json");
  const apps = await readAppsIndex(indexPath);
  const idx = apps.findIndex((entry) => entry.id === input.appId);
  const assigned = withWorkspaceScope(
    idx >= 0
      ? { ...apps[idx], ...input.sourceApp }
      : withWorkspaceScope(input.sourceApp, scope),
    scope,
  );
  assigned.updatedAt = new Date().toISOString();

  if (idx >= 0) {
    apps[idx] = assigned;
  } else {
    apps.push(assigned);
  }
  await writeAppsIndex(indexPath, apps);
  await writeCloudAppMetadataFile(paprHome, input.appId);
}

export async function assignAppToWorkspace(
  input: AssignAppToWorkspaceInput,
): Promise<AssignAppToWorkspaceResult> {
  const targetHome = resolveOrgNamespaceWorkspacePath(
    input.targetOrganizationId,
    input.targetNamespaceId,
  );
  const sourceHome = path.resolve(input.sourcePaprHome);
  const effectiveSourceHome = await resolveSourcePaprHomeForApp(
    input.appId,
    sourceHome,
  );
  const scope: AppWorkspaceScope = {
    organizationId: input.targetOrganizationId,
    namespaceId: input.targetNamespaceId,
  };

  if (path.normalize(targetHome) === path.normalize(sourceHome)) {
    await ensureTargetHasAppBundle({
      appId: input.appId,
      targetHome,
      sourceHome: effectiveSourceHome,
    });
    await updateAssignedAppIndex(sourceHome, input, scope);

    const removedDuplicateHomes = await removeUnassignedDuplicateAppCopies(
      input.appId,
      scope,
    );

    return {
      action: "assigned",
      organizationId: scope.organizationId,
      namespaceId: scope.namespaceId,
      removedDuplicateHomes,
    };
  }

  const copyInput: CopyAppToNamespaceInput = {
    appId: input.appId,
    targetOrganizationId: input.targetOrganizationId,
    targetNamespaceId: input.targetNamespaceId,
    sourcePaprHome: effectiveSourceHome,
  };

  try {
    await copyAppToNamespace(copyInput);
    const targetIndexPath = path.join(targetHome, "data", "apps.json");
    const targetApps = await readAppsIndex(targetIndexPath);
    const idx = targetApps.findIndex((entry) => entry.id === input.appId);
    if (idx >= 0) {
      targetApps[idx] = withWorkspaceScope(targetApps[idx], scope);
      targetApps[idx].updatedAt = new Date().toISOString();
      await writeAppsIndex(targetIndexPath, targetApps);
      await writeCloudAppMetadataFile(targetHome, input.appId);
    }
  } catch (error) {
    if (error instanceof CopyAppError && error.code === "target_conflict") {
      await copyAppBundleAndLinkedResources(
        effectiveSourceHome,
        targetHome,
        input.appId,
      );
      await ensureTargetHasAppBundle({
        appId: input.appId,
        targetHome,
        sourceHome: effectiveSourceHome,
      });
      await updateAssignedAppIndex(targetHome, input, scope);
    } else {
      throw error;
    }
  }

  const targetAppDir = path.join(targetHome, "apps", input.appId);
  if (await appDirHasRunnableBundle(targetAppDir)) {
    if (path.normalize(effectiveSourceHome) !== path.normalize(targetHome)) {
      await removeAppFromNamespaceHome(effectiveSourceHome, input.appId);
    }
    if (
      path.normalize(sourceHome) !== path.normalize(targetHome) &&
      path.normalize(sourceHome) !== path.normalize(effectiveSourceHome)
    ) {
      await removeAppFromNamespaceHome(sourceHome, input.appId);
    }
  }

  const removedDuplicateHomes = await removeUnassignedDuplicateAppCopies(
    input.appId,
    scope,
  );

  return {
    action: "moved",
    organizationId: scope.organizationId,
    namespaceId: scope.namespaceId,
    removedDuplicateHomes,
  };
}
