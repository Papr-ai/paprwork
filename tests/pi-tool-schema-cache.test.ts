import { describe, expect, test, beforeEach } from "vitest";
import { z } from "zod";
import {
  clearPiToolSchemaCacheForTests,
  getPiToolParameters,
  getPiToolSchemaCacheSize,
} from "../src/gateway/services/providers/piToolSchemaCache.js";

describe("piToolSchemaCache", () => {
  beforeEach(() => {
    clearPiToolSchemaCacheForTests();
  });

  test("converts each tool schema only once", () => {
    const schema = z.object({
      path: z.string(),
      limit: z.number().optional(),
    });

    const first = getPiToolParameters("read_file", schema);
    const second = getPiToolParameters("read_file", schema);

    expect(getPiToolSchemaCacheSize()).toBe(1);
    expect(second).toBe(first);
    expect(first).not.toBeNull();
    expect(first.properties).toBeDefined();
    expect(Object.keys(first.properties as Record<string, unknown>)).toContain(
      "path",
    );
  });

  test("uses separate cache entries per tool id", () => {
    const schemaA = z.object({ a: z.string() });
    const schemaB = z.object({ b: z.number() });

    getPiToolParameters("tool_a", schemaA);
    getPiToolParameters("tool_b", schemaB);

    expect(getPiToolSchemaCacheSize()).toBe(2);
  });
});
