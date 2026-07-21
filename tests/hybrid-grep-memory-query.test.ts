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
  const grepPath = `~/Papr/apps/${appId}/`;

  test("builds enriched query from pattern and path", () => {
    const query = buildHybridMemorySearchQuery("authentication", grepPath);
    expect(query).toContain("authentication");
    expect(query).toContain(appId);
    expect(query).toContain("mini-apps");
  });

  test("extractProjectIdFromPaprPath finds UUID in Papr paths", () => {
    expect(extractProjectIdFromPaprPath(grepPath)).toBe(appId);
    expect(
      extractProjectIdFromPaprPath("~/Papr/Jobs/6c840212-9cdc-4b2e-a3ae-951ee2f277a1/code"),
    ).toBe("6c840212-9cdc-4b2e-a3ae-951ee2f277a1");
    expect(extractProjectIdFromPaprPath("~/Papr/apps/")).toBeUndefined();
  });

  test("reminds on Papr grep when agent skips search_agent_memory", () => {
    initializeMemorySearchGate({ hasPaprApiKey: true });
    const reminder = getMemorySearchReminderForTool("bash", {
      command: 'grep -r "auth" ~/Papr/apps/',
    });
    expect(reminder).toContain("search_agent_memory");
    expect(reminder).toContain('category "code"');
  });
});
