/**
 * Install a Papr Cloud catalog app into the local workspace (fork or track).
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import type { RequiredKeySpec } from "../../src/core/types/bundles";
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
