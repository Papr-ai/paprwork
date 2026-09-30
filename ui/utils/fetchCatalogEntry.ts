/**
 * Load a single Team/Community catalog entry by stable catalogId.
 */

import type { CommunityCatalog } from "../../src/core/types/communityCatalog";
import { gateway } from "../src/lib/gateway";

export async function fetchCatalogEntryById(
  catalogId: string,
): Promise<CommunityCatalog["entries"][number] | null> {
  const scopes: Array<{ scope: "namespace" | "global"; namespaceId?: string }> =
    [];

  try {
    const workspace = await window.electronAPI?.papr?.getActiveWorkspace?.();
    const namespaceId = workspace?.pointer?.namespaceId;
    if (namespaceId) {
      scopes.push({ scope: "namespace", namespaceId });
    }
  } catch {
    /* optional */
  }
  scopes.push({ scope: "global" });

  for (const { scope, namespaceId } of scopes) {
    const response = await gateway.send("bundle:fetch-community-catalog", {
      scope,
      ...(namespaceId ? { namespaceId } : {}),
    });
    const catalog = response.data as CommunityCatalog;
    const entry = catalog.entries.find((item) => item.catalogId === catalogId);
    if (entry) {
      return entry;
    }
  }

  return null;
}
