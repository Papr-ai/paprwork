/**
 * Install a Papr Cloud catalog app into the local workspace (fork or track).
 */

import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../src/core/types/communityCatalog";
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

/** Large community apps (many jobs/DBs) can take a few minutes on slow networks. */
export const CLOUD_INSTALL_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

export const CLOUD_INSTALL_TIMEOUT_MESSAGE =
  "Install is taking longer than expected. Check your Apps list for a partial install, then try again.";

export function isCloudInstallTimeoutError(error: string): boolean {
  return error === CLOUD_INSTALL_TIMEOUT_MESSAGE;
}

export function buildCloudInstallTimeoutAgentMessage(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
): string {
  const timeoutMinutes = Math.round(CLOUD_INSTALL_FETCH_TIMEOUT_MS / 60_000);
  return [
    `Community app install for "${entry.name}" timed out in the UI after ${timeoutMinutes} minutes.`,
    "The gateway may still be finishing in the background.",
    "",
    "Please help me:",
    "1. Check Apps for a partial install (often a duplicate title like \"AppName_1\").",
    "2. Verify whether papr-cloud-lineage.json exists under the app folder.",
    "3. Complete the install, or delete the partial copy and retry cleanly.",
    "4. Open the app when it is ready.",
    "",
    `Publisher namespace: ${entry.namespaceId}`,
    `Slug: ${entry.slug}`,
    `Install mode: ${mode}`,
  ].join("\n");
}

export async function installCloudCatalogApp(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
  options?: { catalogScope?: CommunityCatalogScope },
): Promise<{ ok: true; data: CloudInstallResponse } | { ok: false; error: string }> {
  if (!entry.namespaceId || !entry.slug) {
    return { ok: false, error: "This cloud app is missing namespace or slug metadata" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLOUD_INSTALL_FETCH_TIMEOUT_MS,
  );

  try {
    const res = await fetch(`${GATEWAY}/api/cloud/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespaceId: entry.namespaceId,
        slug: entry.slug,
        mode,
        catalogScope: options?.catalogScope,
        visibility: entry.visibility,
      }),
      signal: controller.signal,
    });

    const body = (await res.json()) as CloudInstallResponse;
    if (!res.ok) {
      return { ok: false, error: body.error ?? `Install failed (${res.status})` };
    }

    return { ok: true, data: body };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: CLOUD_INSTALL_TIMEOUT_MESSAGE };
    }
    const message = err instanceof Error ? err.message : "Install failed";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
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
