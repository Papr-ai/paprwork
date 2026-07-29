/**
 * Global cache for zod → JSON Schema conversion used by pi-ai tool definitions.
 * Schemas are static at runtime; converting ~70 tools per stream was wasteful.
 */

import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const EMPTY_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
};

const schemaCache = new Map<string, Record<string, unknown>>();

export function getPiToolParameters(
  toolId: string,
  inputSchema: ZodTypeAny | undefined,
): Record<string, unknown> {
  if (!inputSchema) {
    return { ...EMPTY_PARAMETERS, properties: {} };
  }

  const cacheKey = toolId.trim() || "unknown";
  const cached = schemaCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let parameters: Record<string, unknown> = { ...EMPTY_PARAMETERS, properties: {} };
  try {
    parameters = zodToJsonSchema(
      inputSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
      {
        target: "openApi3",
        $refStrategy: "none",
      },
    ) as Record<string, unknown>;
  } catch (err) {
      console.warn(`Failed to convert schema for tool ${toolId}:`, err);
    }

  schemaCache.set(cacheKey, parameters);
  return parameters;
}

export function getPiToolSchemaCacheSize(): number {
  return schemaCache.size;
}

/** Test helper */
export function clearPiToolSchemaCacheForTests(): void {
  schemaCache.clear();
}
