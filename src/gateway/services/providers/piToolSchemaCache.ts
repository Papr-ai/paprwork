/**
 * Global cache for zod → JSON Schema conversion used by pi-ai tool definitions.
 * Schemas are static at runtime; converting ~70 tools per stream was wasteful.
 *
 * Zod 4: use native z.toJSONSchema() — zod-to-json-schema returns {} for v4 schemas.
 */

import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const EMPTY_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
};

const schemaCache = new Map<string, Record<string, unknown>>();

function hasToolProperties(schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  return (
    typeof props === "object" &&
    props !== null &&
    Object.keys(props as Record<string, unknown>).length > 0
  );
}

function convertZodSchemaToJsonSchema(
  inputSchema: ZodTypeAny,
): Record<string, unknown> {
  if (typeof z.toJSONSchema === "function") {
    try {
      const native = z.toJSONSchema(inputSchema) as Record<string, unknown>;
      if (hasToolProperties(native)) {
        return native;
      }
    } catch (err) {
      console.warn("[piToolSchemaCache] z.toJSONSchema failed:", err);
    }
  }

  try {
    const legacy = zodToJsonSchema(
      inputSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
      {
        target: "openApi3",
        $refStrategy: "none",
      },
    ) as Record<string, unknown>;
    if (hasToolProperties(legacy)) {
      return legacy;
    }
  } catch (err) {
    console.warn("[piToolSchemaCache] zodToJsonSchema failed:", err);
  }

  return { ...EMPTY_PARAMETERS };
}

export function getPiToolParameters(
  toolId: string,
  inputSchema: ZodTypeAny | undefined,
): Record<string, unknown> {
  if (!inputSchema) {
    return { ...EMPTY_PARAMETERS };
  }

  const cacheKey = toolId.trim() || "unknown";
  const cached = schemaCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const parameters = convertZodSchemaToJsonSchema(inputSchema);
  if (!hasToolProperties(parameters)) {
    console.warn(
      `[piToolSchemaCache] Empty JSON Schema for tool "${toolId}" — model will not see parameter names`,
    );
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
