import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalStorageProvider } from "../src/gateway/services/storage/LocalStorageProvider.js";

describe("LocalStorageProvider.patchDelegateTaskToolResult", () => {
  let tmpDir: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-delegation-patch-"));
    provider = new LocalStorageProvider(tmpDir);
    await provider.initialize();
    await provider.createChat("chat-1", "Test");
    await provider.saveMessage("chat-1", {
      id: "msg-1",
      chat_id: "chat-1",
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      sync_status: "local",
      toolCalls: [
        {
          id: "call-delegate-1",
          name: "delegate_task",
          args: { task: "Review app", useAgentId: "product-architect" },
          result: JSON.stringify({
            success: true,
            data: {
              id: "run-abc",
              status: "running",
              task: "Review app",
              agentId: "product-architect",
            },
          }),
          status: "success",
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates stored delegate_task result when delegation completes", () => {
    const patched = provider.patchDelegateTaskToolResult("chat-1", "run-abc", {
      status: "completed",
      resultText: "Full architecture review",
      completedAt: "2026-07-16T12:00:00.000Z",
    });

    expect(patched).toBe(true);

    const db = new Database(path.join(tmpDir, "chats.db"));
    const row = db
      .prepare(`SELECT tool_calls FROM messages WHERE id = 'msg-1'`)
      .get() as { tool_calls: string };
    db.close();

    const toolCalls = JSON.parse(row.tool_calls) as Array<{ result: string }>;
    const parsed = JSON.parse(toolCalls[0]!.result) as {
      data: { status: string; resultText: string };
    };
    expect(parsed.data.status).toBe("completed");
    expect(parsed.data.resultText).toBe("Full architecture review");
  });

  it("returns false when no matching delegation run id exists", () => {
    const patched = provider.patchDelegateTaskToolResult("chat-1", "run-missing", {
      status: "completed",
      resultText: "n/a",
    });
    expect(patched).toBe(false);
  });
});
