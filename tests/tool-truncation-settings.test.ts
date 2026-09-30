/**
 * Verifies tool truncation reads from user settings (not hardcoded constants).
 */
import { describe, expect, test, afterEach, beforeEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  ABSOLUTE_TOOL_RESULT_MAX_CHARS,
  HISTORY_TOOL_RESULT_MAX_CHARS,
  HISTORY_TOOL_RESULT_MODERATE_CHARS,
  RECENT_TURN_RETENTION_COUNT,
  getDefaultHistoryCharLimit,
  resolveHistoryToolResultCharLimit,
  truncateHistoryToolResult,
  truncateToolResultForModelContext,
} from "../src/gateway/services/agent/toolResultTruncation.js";
import { compactStaleToolResults } from "../src/gateway/services/agent/compactToolResults.js";
import { setToolResultTruncationSettings } from "../src/gateway/services/agent/toolResultTruncationSettings.js";
import {
  DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
  mergeToolResultTruncationSettings,
} from "../src/core/types/toolResultTruncationSettings.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

afterEach(() => {
  setToolResultTruncationSettings({ ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS });
});

const longContent = "y".repeat(20_000);

describe("tool truncation settings wiring", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("tool-truncation-settings");

  test("defaults match legacy exported constants", () => {
    expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.aggressiveMaxChars).toBe(
      HISTORY_TOOL_RESULT_MAX_CHARS,
    );
    expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.moderateMaxChars).toBe(
      HISTORY_TOOL_RESULT_MODERATE_CHARS,
    );
    expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.recentTurnRetentionCount).toBe(
      RECENT_TURN_RETENTION_COUNT,
    );
    expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.absoluteMaxChars).toBe(
      ABSOLUTE_TOOL_RESULT_MAX_CHARS,
    );
  });

  test("mergeToolResultTruncationSettings fills missing fields from defaults", () => {
    const merged = mergeToolResultTruncationSettings({ aggressiveMaxChars: 999 });
    expect(merged.aggressiveMaxChars).toBe(999);
    expect(merged.moderateMaxChars).toBe(2000);
    expect(merged.disableAllTruncation).toBe(false);
  });

  test("custom aggressiveMaxChars is used for bash (not hardcoded 400)", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      aggressiveMaxChars: 5000,
    });

    expect(getDefaultHistoryCharLimit("bash")).toBe(5000);

    const truncated = truncateHistoryToolResult({
      toolName: "bash",
      toolCallId: "bash-custom",
      args: {},
      resultStr: longContent,
      history: [
        { role: "user", content: "a" },
        { role: "assistant", content: "", toolCalls: [] },
        { role: "user", content: "b" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "c" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "d" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "e" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "now" },
      ],
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated.startsWith("y".repeat(5000))).toBe(true);
    expect(truncated).toContain("get_full_tool_result");
    expect(truncated.length).toBeGreaterThan(5000);
  });

  test("custom memorySearchMaxChars is used for search_agent_memory", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      memorySearchMaxChars: 3500,
    });

    expect(getDefaultHistoryCharLimit("memory_search")).toBe(3500);
  });

  test("custom recentTurnRetentionCount extends bash full-retention window", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      recentTurnRetentionCount: 10,
    });

    const history = [
      { role: "user", content: "fetch" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "bash", args: {}, result: longContent }],
      },
      { role: "user", content: "t2" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "t3" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "t4" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "t5" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "current" },
    ];

    const limit = resolveHistoryToolResultCharLimit({
      toolName: "bash",
      toolCallId: "bash-retention",
      args: {},
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(limit).toBe(ABSOLUTE_TOOL_RESULT_MAX_CHARS);
  });

  test("disableAllTruncation bypasses all cross-turn limits", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      disableAllTruncation: true,
    });

    const truncated = truncateHistoryToolResult({
      toolName: "bash",
      toolCallId: "bash-off",
      args: {},
      resultStr: longContent,
      history: [],
      messageIndex: 0,
      isOrphan: false,
    });

    expect(truncated).toBe(longContent);
    expect(truncateToolResultForModelContext(longContent, "id", "bash")).toBe(
      longContent,
    );
  });

  test("disableAllTruncation still allows mid-turn compaction when enabled", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      disableAllTruncation: true,
      midTurnCompactionEnabled: true,
    });

    const bashOutput = "q".repeat(8000);
    const messages = [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "b1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b1",
            toolName: "bash",
            output: { type: "text", value: bashOutput },
          },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "two" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "b2", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b2",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];

    compactStaleToolResults(messages);

    const first = (messages[2] as { content: Array<{ output?: { value: string } }> })
      .content[0]!.output?.value;
    expect(first).toBeDefined();
    expect(first!.length).toBeLessThan(bashOutput.length);
  });

  test("midTurnCompactionEnabled false keeps stale bash results full", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      midTurnCompactionEnabled: false,
    });

    const bashOutput = "z".repeat(8000);
    const messages = [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "b1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b1",
            toolName: "bash",
            output: { type: "text", value: bashOutput },
          },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "two" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "b2", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b2",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];

    compactStaleToolResults(messages);

    const first = (messages[2] as { content: Array<{ output?: { value: string } }> })
      .content[0]!.output?.value;
    expect(first).toBe(bashOutput);
  });

  test("custom absoluteMaxChars caps file reads cross-turn", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      absoluteMaxChars: 5000,
    });

    const huge = "f".repeat(20_000);
    const truncated = truncateHistoryToolResult({
      toolName: "read_app_file",
      toolCallId: "read-cap",
      args: { appId: "a", filename: "b.js" },
      resultStr: huge,
      history: [],
      messageIndex: 0,
      isOrphan: false,
    });

    expect(truncated.length).toBeLessThan(huge.length);
    expect(truncated.length).toBeGreaterThan(5000);
    expect(truncated).toContain("get_full_tool_result");
  });

  test("edit_app_file_lines uses settings absolute cap (category full)", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      absoluteMaxChars: 8000,
    });

    const editResult = "e".repeat(6000);
    const truncated = truncateHistoryToolResult({
      toolName: "edit_app_file_lines",
      toolCallId: "edit-1",
      args: {},
      resultStr: editResult,
      history: [],
      messageIndex: 0,
      isOrphan: false,
    });

    expect(truncated).toBe(editResult);
  });

  describe("PAPR_HOME settings path (cloud agent sandbox)", () => {
    const previousPaprHome = process.env.PAPR_HOME;
    let tempRoot = "";

    beforeEach(async () => {
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-trunc-cloud-"));
      process.env.PAPR_HOME = path.join(tempRoot, "Papr");
      await fs.mkdir(path.join(process.env.PAPR_HOME, "data"), { recursive: true });
    });

    afterEach(async () => {
      if (previousPaprHome === undefined) delete process.env.PAPR_HOME;
      else process.env.PAPR_HOME = previousPaprHome;
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    test("getSettingsPath follows PAPR_HOME clone", async () => {
      const { getSettingsPath } = await import(
        "../src/gateway/services/settingsStore.js"
      );
      expect(getSettingsPath()).toBe(
        path.join(process.env.PAPR_HOME!, "data", "settings.json"),
      );
    });

    test("refreshToolResultTruncationSettings loads synced settings.json", async () => {
      const settingsFile = path.join(process.env.PAPR_HOME!, "data", "settings.json");
      await fs.writeFile(
        settingsFile,
        JSON.stringify({
          toolResultTruncation: {
            disableAllTruncation: true,
            aggressiveMaxChars: 1234,
          },
        }),
        "utf8",
      );

      const { refreshToolResultTruncationSettings, getToolResultTruncationSettings } =
        await import("../src/gateway/services/agent/toolResultTruncationSettings.js");
      await refreshToolResultTruncationSettings();

      const cached = getToolResultTruncationSettings();
      expect(cached.disableAllTruncation).toBe(true);
      expect(cached.aggressiveMaxChars).toBe(1234);
      expect(cached.moderateMaxChars).toBe(
        DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.moderateMaxChars,
      );
    });
  });
});
