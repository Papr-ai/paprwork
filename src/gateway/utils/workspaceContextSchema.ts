/**
 * Resolve the built-in WorkspaceContext knowledge-graph schema for the active namespace.
 * Used by add_agent_memory (graph mode auto) and local wiki entity sync.
 */

import type Papr from "@papr/memory";
import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";
import { getPaprClient } from "../../core/tools/paprClient.js";
import { buildAddPolicy } from "./paprMemoryPolicy.js";

const WORKSPACE_CONTEXT_SCHEMA_NAME = "WorkspaceContext";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedSchemaId: string | undefined;
let cachedAtMs = 0;

function isCacheFresh(): boolean {
  return (
    cachedSchemaId !== undefined && Date.now() - cachedAtMs < CACHE_TTL_MS
  );
}

export function clearWorkspaceContextSchemaCache(): void {
  cachedSchemaId = undefined;
  cachedAtMs = 0;
}

export async function resolveWorkspaceContextSchemaId(
  client?: Papr,
): Promise<string | undefined> {
  if (isCacheFresh()) {
    return cachedSchemaId;
  }

  try {
    const papr = client ?? (await getPaprClient());
    const response = await papr.schemas.list({ status_filter: "active" });
    const schemas = response.data ?? [];

    const match = schemas.find(
      (schema) => schema.name === WORKSPACE_CONTEXT_SCHEMA_NAME,
    );

    if (match?.id) {
      cachedSchemaId = match.id;
      cachedAtMs = Date.now();
      return match.id;
    }

    // Retry without status filter — schema may still be draft on first namespace use
    const allResponse = await papr.schemas.list({});
    const fallback = (allResponse.data ?? []).find(
      (schema) => schema.name === WORKSPACE_CONTEXT_SCHEMA_NAME,
    );

    if (fallback?.id) {
      cachedSchemaId = fallback.id;
      cachedAtMs = Date.now();
      return fallback.id;
    }
  } catch (error) {
    console.warn(
      "[WorkspaceContextSchema] Failed to resolve schema:",
      error instanceof Error ? error.message : error,
    );
  }

  cachedSchemaId = undefined;
  cachedAtMs = Date.now();
  return undefined;
}

/** Default add policy for agent memories: optional signal domain + graph auto extraction. */
export async function buildAgentMemoryAddPolicy(input?: {
  signalDomain?: string;
  client?: Papr;
}): Promise<MemoryAddPolicy | undefined> {
  const schemaId = await resolveWorkspaceContextSchemaId(input?.client);
  return buildAddPolicy({
    signalDomain: input?.signalDomain,
    ...(schemaId
      ? { graphMode: "auto" as const, graphSchemaId: schemaId }
      : {}),
  });
}
