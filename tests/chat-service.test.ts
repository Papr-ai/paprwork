import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { ChatService } from "../src/gateway/services/ChatService.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe("ChatService", () => {
  let originalHome: string | undefined;
  let testHomeDir: string;
  let chatService: ChatService;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    testHomeDir = path.join(os.tmpdir(), `paprwork-v2-chat-service-${Date.now()}`);
    process.env.HOME = testHomeDir;
    await fs.mkdir(testHomeDir, { recursive: true });
    chatService = new ChatService();
    await chatService.initialize();
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  test("creates and lists chats", async () => {
    const created = await chatService.createChat("My Chat");
    const chats = chatService.listChats();

    expect(created.title).toBe("My Chat");
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe(created.id);
  });

  test("updates chat metadata", async () => {
    const created = await chatService.createChat("Initial");
    const updated = await chatService.updateChat(created.id, {
      title: "Updated",
      messageCount: 5,
    });

    expect(updated.title).toBe("Updated");
    expect(updated.messageCount).toBe(5);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime() - 1,
    );
  });

  test("deletes chat and clears active chat", async () => {
    const created = await chatService.createChat("To Delete");
    chatService.setActiveChat(created.id);

    await chatService.deleteChat(created.id);

    expect(chatService.getChat(created.id)).toBeUndefined();
    expect(chatService.getActiveChat()).toBeNull();
  });

  test("auto updates title only for fresh chat", async () => {
    const created = await chatService.createChat("New Chat");
    await chatService.autoUpdateTitle(created.id, "First message for title generation");
    const updated = chatService.getChat(created.id);

    expect(updated).toBeDefined();
    expect(updated?.title).not.toBe("New Chat");
    expect(updated?.messageCount).toBe(1);
  });

  test("persists chats on disk", async () => {
    await chatService.createChat("Persistent Chat");
    await chatService.shutdown();

    const chatsPath = path.join(testHomeDir, ".paprwork", "data", "chats.json");
    const exists = await pathExists(chatsPath);
    const content = exists ? await fs.readFile(chatsPath, "utf8") : "";

    expect(exists).toBe(true);
    expect(content).toContain("Persistent Chat");
  });
});
