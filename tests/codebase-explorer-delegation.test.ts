import { describe, expect, test } from "vitest";
import {
  CODEBASE_EXPLORER_SUB_AGENT_ID,
  EXPLORATION_DELEGATION_RESULT_EXCERPT_CHARS,
  resolveDelegationResultExcerptChars,
} from "../src/core/subagents/codebaseExplorer.js";
import { BUILTIN_SUB_AGENT_IDS } from "../src/gateway/services/SubAgentService.js";

describe("codebase-explorer delegation", () => {
  test("is seeded as a built-in sub-agent", () => {
    expect(BUILTIN_SUB_AGENT_IDS).toContain(CODEBASE_EXPLORER_SUB_AGENT_ID);
  });

  test("resolveDelegationResultExcerptChars uses 48K for codebase-explorer", () => {
    expect(resolveDelegationResultExcerptChars(CODEBASE_EXPLORER_SUB_AGENT_ID)).toBe(
      EXPLORATION_DELEGATION_RESULT_EXCERPT_CHARS,
    );
    expect(EXPLORATION_DELEGATION_RESULT_EXCERPT_CHARS).toBe(48_000);
  });

  test("resolveDelegationResultExcerptChars uses 4K for other sub-agents", () => {
    expect(resolveDelegationResultExcerptChars("product-architect")).toBe(4_000);
    expect(resolveDelegationResultExcerptChars(undefined)).toBe(4_000);
    expect(resolveDelegationResultExcerptChars("research-specialist")).toBe(
      4_000,
    );
  });
});
