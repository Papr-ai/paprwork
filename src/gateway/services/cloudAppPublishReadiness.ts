/**
 * Publish readiness preview and runtime feature availability for cross-app deps.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import type {
  AppFeatureAvailabilityReport,
  CloudAppDependencyRef,
  CloudDependencyAppStatus,
  CloudPublishReadinessReport,
  FeatureAvailabilityEntry,
} from "../../core/types/cloudAppDependencies.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { getAppPublishPrefs } from "./cloudPublishPrefs.js";
import { getCloudAppLineageService } from "./CloudAppLineageService.js";
import {
  detectCrossAppDependencies,
  readCloudAppDependenciesFile,
  reconcileAppDataSourcesForPublish,
  validatePublishBundleIntegrity,
} from "./cloudAppResourceIntegrity.js";
import { DATABASES_REGISTRY_FILENAME, type DatabasesRegistryFile } from "./DatabaseRegistryService.js";
import { promises as fs } from "node:fs";

function featureKeyFromDep(dep: CloudAppDependencyRef): string {
  if (dep.slug?.trim()) {
    return dep.slug.trim();
  }
  return dep.appId;
}

function featureKeyFromDbAlias(alias: string | undefined, dbId: string): string {
  const trimmed = alias?.trim();
  if (trimmed) {
    return trimmed.replace(/\s+/g, "_").toLowerCase();
  }
  return `db_${dbId.slice(0, 8)}`;
}

function buildCopyInstallNote(
  appTitle: string,
  apps: CloudDependencyAppStatus[],
): string | null {
  const optional = apps.filter((dep) => !dep.required);
  if (optional.length === 0) {
    return null;
  }
  const lines = optional.map((dep) => {
    const label = dep.title ?? dep.slug ?? dep.appId;
    const enables =
      dep.enables && dep.enables.length > 0
        ? ` (enables: ${dep.enables.join(", ")})`
        : "";
    return `- ${label}${enables}`;
  });
  return (
    `${appTitle} works on its own. For full functionality, also install:\n` +
    `${lines.join("\n")}\n\n` +
    `Install each app separately from Community Apps.`
  );
}

async function readAppTitle(paprDir: string, appId: string): Promise<string> {
  const metadataPath = path.join(paprDir, "apps", appId, "metadata.json");
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as { title?: string };
    if (parsed.title?.trim()) {
      return parsed.title.trim();
    }
  } catch {
    /* no metadata */
  }
  return appId;
}

function resolveDepPublishStatus(
  paprDir: string,
  dep: CloudAppDependencyRef,
): Pick<CloudDependencyAppStatus, "localAppExists" | "publishedToCommunity"> {
  const localAppExists = existsSync(path.join(paprDir, "apps", dep.appId));
  const prefs = getAppPublishPrefs(dep.appId, paprDir);
  const publishedToCommunity = prefs.accessMode === "public_read";
  return { localAppExists, publishedToCommunity };
}

export async function buildCloudPublishReadiness(
  paprDir: string,
  appId: string,
): Promise<CloudPublishReadinessReport> {
  const reconcile = await reconcileAppDataSourcesForPublish(paprDir, appId, {
    dryRun: true,
  });
  const integrity = await validatePublishBundleIntegrity(paprDir, appId);
  const depsFile = await detectCrossAppDependencies(paprDir, appId);

  const appStatuses: CloudDependencyAppStatus[] = depsFile.apps.map((dep) => ({
    ...dep,
    ...resolveDepPublishStatus(paprDir, dep),
  }));

  const appTitle = await readAppTitle(paprDir, appId);
  const warnings = [...integrity.warnings, ...reconcile.warnings];

  return {
    ok: integrity.ok,
    errors: integrity.errors,
    warnings,
    reconcile,
    dependencies: {
      apps: appStatuses,
      databases: depsFile.databases,
    },
    copyInstallNote: buildCopyInstallNote(appTitle, appStatuses),
  };
}

async function readDatabasesRegistry(paprDir: string): Promise<DatabasesRegistryFile> {
  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    return JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return { version: 1, databases: {} };
  }
}

async function isDependencyAppInstalled(
  paprDir: string,
  dep: CloudAppDependencyRef,
  lineageBySlug: Map<string, boolean>,
): Promise<boolean> {
  if (existsSync(path.join(paprDir, "apps", dep.appId))) {
    return true;
  }
  const slug = dep.slug?.trim();
  if (slug && lineageBySlug.get(slug) === true) {
    return true;
  }
  return false;
}

async function buildLineageSlugIndex(paprDir: string): Promise<Map<string, boolean>> {
  const appsDir = path.join(paprDir, "apps");
  const index = await getCloudAppLineageService(appsDir).buildIndex();
  const bySlug = new Map<string, boolean>();
  for (const entry of Object.values(index.byAppId)) {
    if (entry.sourceSlug?.trim()) {
      bySlug.set(entry.sourceSlug.trim(), true);
    }
  }
  return bySlug;
}

export async function assessAppFeatureAvailability(
  paprDir: string,
  appId: string,
): Promise<AppFeatureAvailabilityReport> {
  const appDir = path.join(paprDir, "apps", appId);
  const deps =
    (await readCloudAppDependenciesFile(appDir)) ??
    (await detectCrossAppDependencies(paprDir, appId));

  const lineageBySlug = await buildLineageSlugIndex(paprDir);
  const registry = await readDatabasesRegistry(paprDir);
  const features: Record<string, FeatureAvailabilityEntry> = {};

  const optionalApps: AppFeatureAvailabilityReport["optionalApps"] = [];

  for (const dep of deps.apps) {
    const installed = await isDependencyAppInstalled(paprDir, dep, lineageBySlug);
    optionalApps.push({
      appId: dep.appId,
      title: dep.title,
      slug: dep.slug,
      installed,
      enables: dep.enables,
    });

    const key = featureKeyFromDep(dep);
    if (installed) {
      features[key] = { available: true };
      continue;
    }

    const label = dep.title ?? dep.slug ?? "another app";
    features[key] = {
      available: false,
      reason: `Install ${label} separately to enable this feature.`,
      installSlug: dep.slug,
      ownerTitle: dep.title,
      ownerAppId: dep.appId,
    };
  }

  for (const dbDep of deps.databases) {
    const record = registry.databases[dbDep.dbId];
    const dbPresent =
      Boolean(record) && record?.status !== "tombstone";
    const key = featureKeyFromDbAlias(dbDep.alias, dbDep.dbId);

    if (dbPresent) {
      features[key] = { available: true };
      continue;
    }

    const ownerLabel = dbDep.ownerTitle ?? dbDep.ownerSlug ?? dbDep.ownerAppId;
    features[key] = {
      available: false,
      reason: `Install ${ownerLabel} to use the "${dbDep.alias ?? dbDep.dbId}" database.`,
      installSlug: dbDep.ownerSlug,
      ownerTitle: dbDep.ownerTitle,
      ownerAppId: dbDep.ownerAppId,
    };
  }

  return { appId, features, optionalApps };
}

export async function buildCloudPublishReadinessForApp(
  appId: string,
): Promise<CloudPublishReadinessReport> {
  return buildCloudPublishReadiness(getPaprRoot(), appId);
}

export async function assessAppFeatureAvailabilityForApp(
  appId: string,
): Promise<AppFeatureAvailabilityReport> {
  return assessAppFeatureAvailability(getPaprRoot(), appId);
}
