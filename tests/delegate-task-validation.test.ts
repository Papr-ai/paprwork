import { describe, expect, it } from "vitest";
import {
  buildDelegateTaskValidationError,
  DELEGATE_TASK_EXAMPLE,
  formatDelegateTaskZodError,
  unwrapDelegateTaskRawInput,
} from "../src/core/tools/delegateTaskValidation.js";
import { z } from "zod";

describe("delegateTaskValidation", () => {
  it("rejects agentId with actionable retry message", () => {
    const err = buildDelegateTaskValidationError({
      agentId: "product-architect",
      task: "Brief for todo app",
    });
    expect(err).toContain("useAgentId");
    expect(err).toContain("agentId");
    expect(err).toContain(DELEGATE_TASK_EXAMPLE);
  });

  it("rejects missing useAgentId when task is present", () => {
    const err = buildDelegateTaskValidationError({
      task: "Brief for todo app",
    });
    expect(err).toContain("missing required useAgentId");
    expect(err).toContain("product-architect");
  });

  it("accepts valid raw input", () => {
    const err = buildDelegateTaskValidationError({
      useAgentId: "product-architect",
      task: "Brief",
    });
    expect(err).toBeNull();
  });

  it("unwraps Mastra context wrapper", () => {
    const raw = unwrapDelegateTaskRawInput({
      context: { useAgentId: "product-architect", task: "x" },
    });
    expect(raw.useAgentId).toBe("product-architect");
  });

  it("formatDelegateTaskZodError explains unknown keys", () => {
    const schema = z.object({ useAgentId: z.string(), task: z.string() }).strict();
    const result = schema.safeParse({
      agentId: "product-architect",
      task: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatDelegateTaskZodError(result.error);
      expect(msg).toContain("unknown parameter");
      expect(msg).toContain(DELEGATE_TASK_EXAMPLE);
    }
  });
});
