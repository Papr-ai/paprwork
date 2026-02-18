import { describe, expect, test } from "vitest";
import { z } from "zod";
import { allTools } from "../src/core/tools/index.js";

describe("Tool schemas OpenAI compatibility", () => {
  test("all tool input schemas are root objects", () => {
    for (const tool of allTools) {
      const schema = (tool as unknown as { inputSchema?: unknown }).inputSchema;
      expect(schema, `Tool ${tool.id} is missing inputSchema`).toBeDefined();

      const isObjectSchema = schema instanceof z.ZodObject;
      expect(
        isObjectSchema,
        `Tool ${tool.id} must use root z.object(...) inputSchema for OpenAI function calling`,
      ).toBe(true);
    }
  });
});
