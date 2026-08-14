/**
 * Resolve the WorkspaceContext knowledge-graph schema for the active namespace.
 *
 * Schema selection is client-driven (same pattern as code indexing):
 * - Paprwork resolves the schema ID and passes policy.graph.schema_id
 * - Memory server uses that ID, or LLM auto-selects when none is provided
 */

import type Papr from "@papr/memory";
import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";
import { getPaprClient } from "../../core/tools/paprClient.js";
import { buildAddPolicy } from "./paprMemoryPolicy.js";

import { WORKSPACE_CONTEXT_SCHEMA_NAME } from "../../core/utils/memoryGraphSchemaRead.js";

export { WORKSPACE_CONTEXT_SCHEMA_NAME };
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

/** List active WorkspaceContext schema in the namespace (does not register). */
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

/**
 * Default add policy for agent memories.
 *
 * Passes an explicit graph schema when resolved (WorkspaceContext for wiki/meeting
 * memories). When no schema is found, omits graph policy so the memory server can
 * auto-select or skip — same separation as code indexing (client picks schema/domain).
 */
export async function buildAgentMemoryAddPolicy(input?: {
  signalDomain?: string;
  /** Override graph schema (e.g. custom KG schema). Defaults to WorkspaceContext. */
  graphSchemaId?: string;
  client?: Papr;
}): Promise<MemoryAddPolicy | undefined> {
  const schemaId =
    input?.graphSchemaId ??
    (await resolveWorkspaceContextSchemaId(input?.client));

  if (!schemaId) {
    console.warn(
      "[WorkspaceContextSchema] No graph schema resolved — omitting graph policy; memory server will auto-select if graph extraction runs.",
    );
    return buildAddPolicy({
      signalDomain: input?.signalDomain,
    });
  }

  return buildAddPolicy({
    signalDomain: input?.signalDomain,
    graphMode: "auto",
    graphSchemaId: schemaId,
  });
}
