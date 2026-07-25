import { describe, expect, test, afterEach } from "vitest";
import {
  ABSOLUTE_TOOL_RESULT_MAX_CHARS,
  categorizeTool,
  countUserTurnsAfter,
  getDefaultHistoryCharLimit,
  HEAD_TAIL_TRUNCATION_MAX_CHARS,
  HISTORY_TOOL_RESULT_MAX_CHARS,
  RECENT_TURN_RETENTION_COUNT,
  resolveHistoryToolResultCharLimit,
  truncateHistoryToolResult,
  truncateToCharLimit,
  truncateToolResultForModelContext,
} from "../src/gateway/services/agent/toolResultTruncation.js";
import { formatHistoryMessagesForModel } from "../src/gateway/services/agent/historyFormatter.js";
import { setToolResultTruncationSettings } from "../src/gateway/services/agent/toolResultTruncationSettings.js";
import { DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS } from "../src/core/types/toolResultTruncationSettings.js";
import { compactStaleToolResults } from "../src/gateway/services/agent/compactToolResults.js";

afterEach(() => {
  setToolResultTruncationSettings({ ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS });
});

const longContent = "x".repeat(20_000);
const hugeContent = "x".repeat(50_000);

describe("toolResultTruncation", () => {
  test("categorizes common tools", () => {
    expect(categorizeTool("bash")).toBe("bash");
    expect(categorizeTool("read_app_file")).toBe("file_read");
    expect(categorizeTool("edit_app_file_lines")).toBe("file_edit");
    expect(categorizeTool("get_file_code_summary")).toBe("code_cache");
    expect(categorizeTool("create_plan")).toBe("small_crud");
  });

  test("file reads under absolute cap stay full in history", () => {
    expect(getDefaultHistoryCharLimit("file_read")).toBeNull();

    const history = [
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "read_app_file",
            args: { appId: "app-1", filename: "dashboard.js" },
            result: longContent,
          },
        ],
      },
      { role: "user", content: "later turn" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "even later" },
    ];

    const limit = resolveHistoryToolResultCharLimit({
      toolName: "read_app_file",
      toolCallId: "read-1",
      args: { appId: "app-1", filename: "dashboard.js" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(limit).toBe(ABSOLUTE_TOOL_RESULT_MAX_CHARS);

    const truncated = truncateHistoryToolResult({
      toolName: "read_app_file",
      toolCallId: "read-1",
      args: { appId: "app-1", filename: "dashboard.js" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated).toBe(longContent);
  });

  test("file reads above absolute cap truncate with get_full_tool_result hint", () => {
    const truncated = truncateHistoryToolResult({
      toolName: "read_app_file",
      toolCallId: "read-huge",
      args: { appId: "app-1", filename: "big.js" },
      resultStr: hugeContent,
      history: [],
      messageIndex: 0,
      isOrphan: false,
    });

    expect(truncated.length).toBeLessThan(hugeContent.length);
    expect(truncated).toContain("get_full_tool_result");
    expect(truncated).toContain("read-huge");
  });

  test("truncateToolResultForModelContext caps mid-turn results", () => {
    const truncated = truncateToolResultForModelContext(
      hugeContent,
      "call-mid",
      "bash",
    );
    expect(truncated.length).toBeLessThan(hugeContent.length);
    expect(truncated).toContain("get_full_tool_result");
  });

  test("bash results truncate to default limit when older than retention window", () => {
    const history = [
      { role: "user", content: "fetch" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "bash", args: { command: "curl api" }, result: longContent }],
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
      toolCallId: "call-1",
      args: { command: "curl api" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });
    expect(limit).toBe(HISTORY_TOOL_RESULT_MAX_CHARS);
    expect(
      countUserTurnsAfter(history, 1),
    ).toBeGreaterThanOrEqual(RECENT_TURN_RETENTION_COUNT);
  });

  test("recent bash results under absolute cap stay full within last 4 user turns", () => {
    const history = [
      { role: "user", content: "fetch transcript" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "bash", args: { command: "curl attention" }, result: longContent }],
      },
      { role: "user", content: "follow-up about report" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "another question" },
    ];

    expect(countUserTurnsAfter(history, 1)).toBe(2);

    const limit = resolveHistoryToolResultCharLimit({
      toolName: "bash",
      toolCallId: "call-recent",
      args: { command: "curl attention" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });
    expect(limit).toBe(ABSOLUTE_TOOL_RESULT_MAX_CHARS);

    const truncated = truncateHistoryToolResult({
      toolName: "bash",
      toolCallId: "call-recent",
      args: { command: "curl attention" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });
    expect(truncated).toBe(longContent);
  });

  test("recent bash results above absolute cap truncate with recovery hint", () => {
    const history = [
      { role: "user", content: "fetch transcript" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "bash", args: { command: "curl huge" }, result: hugeContent }],
      },
      { role: "user", content: "follow-up" },
    ];

    const truncated = truncateHistoryToolResult({
      toolName: "bash",
      toolCallId: "call-huge-bash",
      args: { command: "curl huge" },
      resultStr: hugeContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated.length).toBeLessThan(hugeContent.length);
    expect(truncated).toContain("get_full_tool_result");
  });

  test("edit results use absolute cap only (usually small)", () => {
    const limit = resolveHistoryToolResultCharLimit({
      toolName: "edit_app_file_lines",
      toolCallId: "call-2",
      args: { appId: "app-1", filename: "a.js" },
      resultStr: longContent,
      history: [],
      messageIndex: 0,
      isOrphan: false,
    });
    expect(limit).toBe(ABSOLUTE_TOOL_RESULT_MAX_CHARS);
    expect(
      truncateHistoryToolResult({
        toolName: "edit_app_file_lines",
        toolCallId: "call-2",
        args: { appId: "app-1", filename: "a.js" },
        resultStr: longContent,
        history: [],
        messageIndex: 0,
        isOrphan: false,
      }),
    ).toBe(longContent);
  });

  test("formatHistoryMessagesForModel preserves file read under absolute cap", () => {
    const history = [
      { role: "user", content: "read dashboard" },
      {
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "read-1",
            name: "read_app_file",
            args: { appId: "app-1", filename: "dashboard.js" },
            result: longContent,
            status: "success",
          },
        ],
      },
      { role: "user", content: "unrelated follow-up" },
    ];

    const messages = formatHistoryMessagesForModel(history);
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();

    const toolContent = toolMessage!.content as Array<{
      toolName: string;
      output: { value: string };
    }>;
    const readResult = toolContent.find(
      (part) => part.toolName === "read_app_file",
    );
    expect(readResult).toBeDefined();
    expect(readResult!.output.value.length).toBe(longContent.length);
  });

  test("code cache tools use moderate default limit", () => {
    expect(getDefaultHistoryCharLimit("code_cache")).toBe(2000);
  });

  test("validate_app uses moderate limit (2KB) for actionable errors", () => {
    expect(getDefaultHistoryCharLimit("validation_preview", "validate_app")).toBe(
      2000,
    );

    const history = [
      { role: "user", content: "validate" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "validate_app", args: { appId: "a" }, result: longContent }],
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
      toolName: "validate_app",
      toolCallId: "val-1",
      args: { appId: "a" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(limit).toBe(2000);
  });

  test("aggressive truncation uses deterministic head+tail", () => {
    const content = `${"H".repeat(300)}MIDDLE${"T".repeat(300)}`;
    const truncated = truncateToCharLimit(
      content,
      HISTORY_TOOL_RESULT_MAX_CHARS,
      "bash-1",
      "bash",
    );

    expect(truncated.length).toBeLessThanOrEqual(
      HISTORY_TOOL_RESULT_MAX_CHARS + 50,
    );
    expect(truncated.startsWith("HHH")).toBe(true);
    expect(truncated).toContain("TTT");
    expect(truncated).toContain("[... omitted ...]");
    expect(truncated).toContain("get_full_tool_result");

    const again = truncateToCharLimit(
      content,
      HISTORY_TOOL_RESULT_MAX_CHARS,
      "bash-1",
      "bash",
    );
    expect(again).toBe(truncated);
  });

  test("large limits use head-only truncation", () => {
    const content = "A".repeat(50_000);
    const truncated = truncateToCharLimit(
      content,
      ABSOLUTE_TOOL_RESULT_MAX_CHARS,
      "read-1",
      "read_app_file",
    );

    expect(truncated.startsWith("AAA")).toBe(true);
    expect(truncated).not.toContain("[... omitted ...]");
    expect(truncated.length).toBeLessThan(content.length);
    expect(HEAD_TAIL_TRUNCATION_MAX_CHARS).toBeLessThan(
      ABSOLUTE_TOOL_RESULT_MAX_CHARS,
    );
  });

  test("list_job_files stays full within recent-turn discovery window", () => {
    const history = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "list_job_files",
            args: { jobId: "job-1" },
            result: longContent,
          },
        ],
      },
      { role: "user", content: "follow-up" },
    ];

    const truncated = truncateHistoryToolResult({
      toolName: "list_job_files",
      toolCallId: "list-1",
      args: { jobId: "job-1" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated).toBe(longContent);
  });

  test("list_job_files truncates to default after discovery retention window", () => {
    const history = [
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "list_job_files", args: { jobId: "j" }, result: longContent },
        ],
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
      toolName: "list_job_files",
      toolCallId: "list-old",
      args: { jobId: "j" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(limit).toBe(HISTORY_TOOL_RESULT_MAX_CHARS);
  });

  test("introspect_memory_graph stays full within recent-turn discovery window", () => {
    const history = [
      { role: "user", content: "schema" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "introspect_memory_graph",
            args: {},
            result: longContent,
          },
        ],
      },
      { role: "user", content: "follow-up" },
    ];

    const truncated = truncateHistoryToolResult({
      toolName: "introspect_memory_graph",
      toolCallId: "intro-1",
      args: {},
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated).toBe(longContent);
  });

  test("get_full_tool_result stays full cross-turn (never memory_search 800 cap)", () => {
    const history = [
      { role: "user", content: "recover" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "get_full_tool_result",
            args: { toolCallId: "orig-1" },
            result: longContent,
          },
        ],
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
      toolName: "get_full_tool_result",
      toolCallId: "recover-1",
      args: { toolCallId: "orig-1" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(limit).toBeNull();

    const truncated = truncateHistoryToolResult({
      toolName: "get_full_tool_result",
      toolCallId: "recover-1",
      args: { toolCallId: "orig-1" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated).toBe(longContent);
  });

  test("disableAllTruncation keeps bash results full cross-turn", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      disableAllTruncation: true,
    });

    const history = [
      { role: "user", content: "fetch" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "bash", args: { command: "curl api" }, result: longContent }],
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

    const truncated = truncateHistoryToolResult({
      toolName: "bash",
      toolCallId: "call-no-trunc",
      args: { command: "curl api" },
      resultStr: longContent,
      history,
      messageIndex: 1,
      isOrphan: false,
    });

    expect(truncated).toBe(longContent);
  });
});

describe("truncation settings", () => {
  test("disableAllTruncation does not skip mid-turn compaction when enabled", () => {
    setToolResultTruncationSettings({
      ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
      disableAllTruncation: true,
      midTurnCompactionEnabled: true,
    });

    const bashOutput = "x".repeat(5000);
    const messages = [
      { role: "user", content: "grep" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "bash-1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-1",
            toolName: "bash",
            output: { type: "text", value: bashOutput },
          },
        ],
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "more" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "bash-2", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-2",
            toolName: "bash",
            output: { type: "text", value: "y".repeat(100) },
          },
        ],
      },
    ];

    compactStaleToolResults(messages);

    const firstBash = (messages[2] as { content: Array<{ output?: { value: string } }> })
      .content[0]!.output?.value;
    expect(firstBash).toBeDefined();
    expect(firstBash!.length).toBeLessThan(bashOutput.length);
  });
});

describe("compactStaleToolResults file read retention", () => {
  test("stale read_file results stay full (not 2KB)", async () => {
    const { compactStaleToolResults } = await import(
      "../src/gateway/services/agent/compactToolResults.js"
    );

    const fileContent = "line\n".repeat(800); // ~4.8KB
    const messages = [
      { role: "user", content: "read the plan" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read_file",
            output: { type: "text", value: fileContent },
          },
        ],
      },
      { role: "assistant", content: "got it" },
      { role: "user", content: "now grep something" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "bash-1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-1",
            toolName: "bash",
            output: { type: "text", value: "x".repeat(5000) },
          },
        ],
      },
    ];

    compactStaleToolResults(messages);

    const readPart = (messages[2] as { content: Array<{ output?: { value: string } }> })
      .content[0]!;
    const bashPart = (messages[6] as { content: Array<{ output?: { value: string } }> })
      .content[0]!;

    const readResult = readPart.output?.value ?? "";
    const bashResult = bashPart.output?.value ?? "";

    expect(readResult).toBe(fileContent);
    expect(bashResult.length).toBeLessThan(5000);
    expect(bashResult.length).toBeGreaterThan(0);
  });
});
