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
  additionalProperties: false,
};

/** Tools with no parameters — empty schema is valid, not an error. */
const ZERO_PARAM_TOOLS = new Set([
  "list_keys",
  "list_sub_agents",
  "reload_jobs",
  "list_job_folders",
  "list_app_bundles",
  "get_papr_workspace",
  "list_signal_domains",
  "webview_list",
]);

/**
 * Manual JSON Schema for tools whose Zod schemas use preprocess/transform
 * (Zod 4 toJSONSchema throws "Transforms cannot be represented").
 */
const MANUAL_PI_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  update_plan: {
    type: "object",
    properties: {
      planId: {
        type: "string",
        description: "Plan ID returned by create_plan",
      },
      updates: {
        type: "array",
        description: "Step status updates",
        items: {
          type: "object",
          properties: {
            stepId: {
              type: "string",
              description: "Step id from create_plan",
            },
            id: {
              type: "string",
              description: "Alias for stepId (same as create_plan step id)",
            },
            status: {
              type: "string",
              description:
                "pending | in_progress | completed | skipped (aliases accepted)",
            },
          },
          required: ["status"],
        },
        minItems: 1,
      },
    },
    required: ["planId", "updates"],
    additionalProperties: false,
  },
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

function isEmptyParameterSchema(inputSchema: ZodTypeAny): boolean {
  return (
    inputSchema instanceof z.ZodObject &&
    Object.keys(inputSchema.shape).length === 0
  );
}

function convertZodSchemaToJsonSchema(
  inputSchema: ZodTypeAny,
): Record<string, unknown> {
  if (isEmptyParameterSchema(inputSchema)) {
    return { ...EMPTY_PARAMETERS };
  }

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

  const manual = MANUAL_PI_TOOL_SCHEMAS[cacheKey];
  const parameters = manual ?? convertZodSchemaToJsonSchema(inputSchema);

  if (
    !hasToolProperties(parameters) &&
    !ZERO_PARAM_TOOLS.has(cacheKey) &&
    !manual
  ) {
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
