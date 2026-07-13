import { describe, expect, test, beforeEach } from "vitest";
import {
  buildMemorySearchReminderText,
  getMemorySearchReminderForTool,
  initializeMemorySearchGate,
  isDirectFileReadBashCommand,
  isMemorySearchGateActive,
  markMemorySearchCompleted,
  wrapToolsWithMemorySearchFirstGate,
} from "../src/core/utils/memorySearchFirstGate.js";
import type { AnyTool } from "../src/core/agents/ToolRegistry.js";

describe("memorySearchFirstGate", () => {
  beforeEach(() => {
    initializeMemorySearchGate({ hasPaprApiKey: true });
  });

  test("allows read_app_file without memory reminder (targeted read)", () => {
    expect(isMemorySearchGateActive()).toBe(true);
    expect(
      getMemorySearchReminderForTool("read_app_file", {
        appId: "x",
        filename: "index.html",
      }),
    ).toBeNull();
  });

  test("suggests memory search for list_app_files without blocking", () => {
    expect(isMemorySearchGateActive()).toBe(true);
    const reminder = getMemorySearchReminderForTool("list_app_files", {
      appId: "x",
    });
    expect(reminder).toContain("search_agent_memory");
    expect(reminder).toContain("prior decisions");
  });

  test("stops reminding after search_agent_memory completes", () => {
    markMemorySearchCompleted();
    expect(isMemorySearchGateActive()).toBe(false);
    expect(getMemorySearchReminderForTool("list_apps", {})).toBeNull();
  });

  test("suggests memory search for non-trivial bash including Papr grep", () => {
    const grepReminder = getMemorySearchReminderForTool("bash", {
      command: 'grep -r "isTranscript" ~/Papr/apps/',
    });
    expect(grepReminder).toContain("search_agent_memory");
    expect(grepReminder).toContain('category "code"');

    initializeMemorySearchGate({ hasPaprApiKey: true });

    const sqliteReminder = getMemorySearchReminderForTool("bash", {
      command: 'sqlite3 "$DB" "SELECT * FROM evidence_sources"',
    });
    expect(sqliteReminder).toContain("search_agent_memory");
  });

  test("allows direct file read bash without memory reminder", () => {
    expect(
      getMemorySearchReminderForTool("bash", {
        command: "cat ~/Papr/apps/my-app/index.html",
      }),
    ).toBeNull();
    expect(
      getMemorySearchReminderForTool("bash", { command: "head -n 50 report.ts" }),
    ).toBeNull();
    expect(isDirectFileReadBashCommand("cat foo.txt")).toBe(true);
    expect(isDirectFileReadBashCommand('grep -r "x" .')).toBe(false);
  });

  test("allows trivial bash without memory reminder", () => {
    expect(getMemorySearchReminderForTool("bash", { command: "pwd" })).toBeNull();
    expect(
      getMemorySearchReminderForTool("bash", { command: "git status" }),
    ).toBeNull();
  });

  test("gate inactive without PAPR_API_KEY", () => {
    initializeMemorySearchGate({ hasPaprApiKey: false });
    expect(isMemorySearchGateActive()).toBe(false);
    expect(getMemorySearchReminderForTool("list_apps", {})).toBeNull();
  });

  test("gate inactive when search_agent_memory not in allowed tools", () => {
    initializeMemorySearchGate({
      hasPaprApiKey: true,
      allowedToolIds: ["bash", "read_file"],
    });
    expect(isMemorySearchGateActive()).toBe(false);
  });

  test("wrapToolsWithMemorySearchFirstGate runs tool and appends reminder", async () => {
    const listTool: AnyTool = {
      id: "list_app_files",
      execute: async () => ({ success: true, data: ["index.html"] }),
    } as AnyTool;

    const searchTool: AnyTool = {
      id: "search_agent_memory",
      execute: async () => ({ success: true, data: { memories: [] } }),
    } as AnyTool;

    const wrapped = wrapToolsWithMemorySearchFirstGate({
      list_app_files: listTool,
      search_agent_memory: searchTool,
    });

    const first = await wrapped.list_app_files.execute?.({});
    expect(first).toMatchObject({
      success: true,
      data: ["index.html"],
      _memorySearchReminder: expect.stringContaining("search_agent_memory"),
    });

    await wrapped.search_agent_memory.execute?.({ query: "test" });

    const second = await wrapped.list_app_files.execute?.({});
    expect(second).toEqual({ success: true, data: ["index.html"] });
    expect(second).not.toHaveProperty("_memorySearchReminder");
  });

  test("wrapToolsWithMemorySearchFirstGate stops reminding after failed search", async () => {
    const listTool: AnyTool = {
      id: "list_apps",
      execute: async () => ({ success: true, data: [] }),
    } as AnyTool;

    const searchTool: AnyTool = {
      id: "search_agent_memory",
      execute: async () => {
        throw new Error("Papr API timeout");
      },
    } as AnyTool;

    const wrapped = wrapToolsWithMemorySearchFirstGate({
      list_apps: listTool,
      search_agent_memory: searchTool,
    });

    await expect(
      wrapped.search_agent_memory.execute?.({ query: "test" }),
    ).rejects.toThrow("Papr API timeout");

    const result = await wrapped.list_apps.execute?.({});
    expect(result).toEqual({ success: true, data: [] });
    expect(result).not.toHaveProperty("_memorySearchReminder");
  });

  test("parse_pdf is not reminded (targeted read with explicit path)", () => {
    expect(
      getMemorySearchReminderForTool("parse_pdf", {
        filePath: "~/Desktop/Swayable_GTM_Audit_Final.pdf",
      }),
    ).toBeNull();
  });

  test("allows browser_navigate without memory reminder (explicit URL)", () => {
    expect(isMemorySearchGateActive()).toBe(true);
    expect(
      getMemorySearchReminderForTool("browser_navigate", {
        url: "https://auditworkbench.papr.ai",
      }),
    ).toBeNull();
    expect(getMemorySearchReminderForTool("browser_snapshot", {})).toBeNull();
  });

  test("reminds only once per turn on first exploration tool", () => {
    const first = getMemorySearchReminderForTool("list_apps", {});
    const second = getMemorySearchReminderForTool("list_app_files", {
      appId: "x",
    });
    expect(first).toContain("search_agent_memory");
    expect(second).toBeNull();
  });

  test("buildMemorySearchReminderText includes code and context guidance", () => {
    const reminder = buildMemorySearchReminderText("list_apps");
    expect(reminder).toContain("search_agent_memory");
    expect(reminder).toContain('category "code"');
    expect(reminder).toContain("current_chat");
  });
});
