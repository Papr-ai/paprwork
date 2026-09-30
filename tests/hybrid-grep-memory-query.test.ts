import { describe, expect, test } from "vitest";
import {
  buildHybridMemorySearchQuery,
  extractProjectIdFromPaprPath,
} from "../src/core/tools/bash.js";
import {
  getMemorySearchReminderForTool,
  initializeMemorySearchGate,
} from "../src/core/utils/memorySearchFirstGate.js";

describe("hybrid grep memory query", () => {
  const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
  const canonicalGrepPath = `~/Papr/orgs/org-1/namespaces/ns-1/apps/${appId}/`;
  const legacyGrepPath = `~/Papr/apps/${appId}/`;

  test("builds enriched query from pattern and canonical org/namespace path", () => {
    const query = buildHybridMemorySearchQuery("authentication", canonicalGrepPath);
    expect(query).toContain("authentication");
    expect(query).toContain(appId);
    expect(query).toContain("mini-apps");
  });

  test("builds enriched query from legacy flat grep path", () => {
    const query = buildHybridMemorySearchQuery("authentication", legacyGrepPath);
    expect(query).toContain("authentication");
    expect(query).toContain(appId);
    expect(query).toContain("mini-apps");
  });

  test("extractProjectIdFromPaprPath finds UUID in canonical and legacy Papr paths", () => {
    expect(extractProjectIdFromPaprPath(canonicalGrepPath)).toBe(appId);
    expect(extractProjectIdFromPaprPath(legacyGrepPath)).toBe(appId);
    expect(
      extractProjectIdFromPaprPath("~/Papr/Jobs/6c840212-9cdc-4b2e-a3ae-951ee2f277a1/code"),
    ).toBe("6c840212-9cdc-4b2e-a3ae-951ee2f277a1");
    expect(
      extractProjectIdFromPaprPath(
        "~/Papr/orgs/org-1/namespaces/ns-1/Jobs/6c840212-9cdc-4b2e-a3ae-951ee2f277a1/code",
      ),
    ).toBe("6c840212-9cdc-4b2e-a3ae-951ee2f277a1");
    expect(extractProjectIdFromPaprPath("~/Papr/apps/")).toBeUndefined();
  });

  test("reminds on Papr grep when agent skips search_agent_memory", () => {
    initializeMemorySearchGate({ hasPaprApiKey: true });
    const reminder = getMemorySearchReminderForTool("bash", {
      command: `grep -r "auth" ${canonicalGrepPath}`,
    });
    expect(reminder).toContain("search_agent_memory");
    expect(reminder).toContain('category "code"');
  });
});
