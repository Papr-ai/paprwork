export interface StructuredOutputResult {
  valid: boolean;
  parsed?: unknown;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): string | null {
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) {
      return "Expected object";
    }
    const required =
      Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string")
        ? (schema.required as string[])
        : [];
    for (const key of required) {
      if (!(key in value)) {
        return `Missing required key: ${key}`;
      }
    }
    const properties =
      isRecord(schema.properties) ? schema.properties : undefined;
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in value)) {
          continue;
        }
        if (!isRecord(propertySchema)) {
          continue;
        }
        const nestedError = validateAgainstSchema(propertySchema, value[key]);
        if (nestedError) {
          return `${key}: ${nestedError}`;
        }
      }
    }
    return null;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      return "Expected array";
    }
    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const nestedError = validateAgainstSchema(
          schema.items,
          value[index],
        );
        if (nestedError) {
          return `[${index}]: ${nestedError}`;
        }
      }
    }
    return null;
  }
  if (type === "string" && typeof value !== "string") {
    return "Expected string";
  }
  if (type === "number" && typeof value !== "number") {
    return "Expected number";
  }
  if (type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    return "Expected integer";
  }
  if (type === "boolean" && typeof value !== "boolean") {
    return "Expected boolean";
  }
  return null;
}

/**
 * Strip markdown code fences that LLMs sometimes wrap JSON in.
 * Handles: ```json ... ```, ``` ... ```, and leading/trailing whitespace.
 */
export function stripMarkdownFences(raw: string): string {
  let cleaned = raw.trim();

  // Remove opening fence: ```json or ```
  const openFencePattern = /^```(?:json|JSON)?\s*\n?/;
  if (openFencePattern.test(cleaned)) {
    cleaned = cleaned.replace(openFencePattern, "");
  }

  // Remove closing fence: ```
  const closeFencePattern = /\n?```\s*$/;
  if (closeFencePattern.test(cleaned)) {
    cleaned = cleaned.replace(closeFencePattern, "");
  }

  return cleaned.trim();
}

/**
 * Legacy fallback: validate raw text as JSON against a loose schema.
 * Used as a safety net when generateObject is not available or fails.
 * Prefer using AI SDK's generateObject with jsonSchema() for new code.
 */
export function validateStructuredOutput(
  raw: string,
  schema?: Record<string, unknown>,
): StructuredOutputResult {
  try {
    const cleaned = stripMarkdownFences(raw);
    const parsed = JSON.parse(cleaned) as unknown;
    if (!schema) {
      return { valid: true, parsed };
    }
    const error = validateAgainstSchema(schema, parsed);
    if (error) {
      return { valid: false, parsed, error };
    }
    return { valid: true, parsed };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
