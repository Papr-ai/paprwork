/**
 * Install a Papr Cloud catalog app into the local workspace (fork or track).
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import type { RequiredKeySpec } from "../../src/core/types/bundles";
import type { CloudAppDependenciesFile } from "../../src/core/types/cloudAppDependencies";
import { normalizeRequirements } from "../../src/core/types/bundles";
import type { RequirementItem } from "../../src/core/types/bundles";

export type CloudInstallMode = "fork" | "track";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface CloudInstallResponse {
  app?: { id: string; title?: string };
  requirements?: RequiredKeySpec[];
  bootstrap?: {
    ready?: boolean;
    needsSeed?: boolean;
    warnings?: string[];
  };
  agentSetupMessage?: string;
  dependencies?: {
    apps: Array<{
      appId: string;
      title?: string;
      slug?: string;
      required: boolean;
      enables?: string[];
    }>;
    databases: Array<{
      dbId: string;
      alias?: string;
      ownerAppId: string;
      ownerTitle?: string;
      required: boolean;
      enables?: string[];
    }>;
  };
  installWarnings?: string[];
  health?: {
    ok?: boolean;
    missingJobIds?: string[];
    missingRequiredDbIds?: string[];
  };
  error?: string;
}

export function userProvidedRequirements(
  reqs: RequirementItem[] | RequiredKeySpec[] | undefined,
): RequiredKeySpec[] {
  if (!reqs?.length) return [];
  return normalizeRequirements(reqs).filter(
    (spec) => spec.required !== false && spec.credentialScope !== "owner",
  );
}

export async function installCloudCatalogApp(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
): Promise<{ ok: true; data: CloudInstallResponse } | { ok: false; error: string }> {
  if (!entry.namespaceId || !entry.slug) {
    return { ok: false, error: "This cloud app is missing namespace or slug metadata" };
  }

  const res = await fetch(`${GATEWAY}/api/cloud/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      namespaceId: entry.namespaceId,
      slug: entry.slug,
      mode,
    }),
  });

  const body = (await res.json()) as CloudInstallResponse;
  if (!res.ok) {
    return { ok: false, error: body.error ?? `Install failed (${res.status})` };
  }

  return { ok: true, data: body };
}

export function extractOptionalInstallDependencies(
  body: CloudInstallResponse,
): CloudAppDependenciesFile | null {
  if (!body.dependencies) {
    return null;
  }
  const apps = body.dependencies.apps.filter((dep) => !dep.required);
  const databases = body.dependencies.databases.filter((dep) => !dep.required);
  if (apps.length === 0 && databases.length === 0) {
    return null;
  }
  return {
    schemaVersion: "1.0.0",
    updatedAt: new Date().toISOString(),
    apps,
    databases,
  };
}

export async function fetchAppFeatureAvailability(appId: string): Promise<
  import("../../src/core/types/cloudAppDependencies").AppFeatureAvailabilityReport
> {
  const res = await fetch(
    `${GATEWAY}/api/apps/${encodeURIComponent(appId)}/feature-availability`,
  );
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Feature availability failed (${res.status})`);
  }
  return (await res.json()) as import("../../src/core/types/cloudAppDependencies").AppFeatureAvailabilityReport;
}

export async function fetchCloudLineageIndex(): Promise<
  import("./communityAppLocalOpen").CloudLineageIndex | null
> {
  try {
    const res = await fetch(`${GATEWAY}/api/cloud/lineage`);
    if (!res.ok) return null;
    return (await res.json()) as import("./communityAppLocalOpen").CloudLineageIndex;
  } catch {
    return null;
  }
}
