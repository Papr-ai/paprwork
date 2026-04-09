import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Tests for the V1 migration handler in settings.ts.
 *
 * We test the migration logic by setting up a fake V1 data directory
 * and calling the handler via a mock WebSocket.
 */

// We can't easily import the private runV1Migration function,
// so we test by calling setupSettingsHandlers with a migrate message.
import { setupSettingsHandlers } from "../src/gateway/websocket/settings.js";
import type { WSMessage } from "../src/gateway/websocket/index.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

interface MockWSMessage {
  type: string;
  data: string;
}

function createMockWs() {
  const sent: MockWSMessage[] = [];
  return {
    ws: {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => sent.push({ type: "send", data }),
    },
    sent,
  };
}

async function setupV1Data(root: string) {
  const v1Root = path.join(root, ".paprwork");

  // Create V1 chat data
  const chatsDir = path.join(v1Root, "chats");
  await fs.mkdir(chatsDir, { recursive: true });

  const chatIndex = {
    chats: [
      { id: "chat-001", title: "My First Chat" },
      { id: "chat-002", title: "My Second Chat" },
    ],
  };
  await fs.writeFile(
    path.join(chatsDir, "index.json"),
    JSON.stringify(chatIndex),
  );

  // Chat 1 messages
  const chat1Messages = [
    JSON.stringify({ role: "user", content: "Hello", timestamp: "2025-01-01T00:00:00Z" }),
    JSON.stringify({ role: "assistant", content: "Hi there!", timestamp: "2025-01-01T00:00:01Z" }),
    JSON.stringify({ role: "user", content: "How are you?", timestamp: "2025-01-01T00:00:02Z" }),
  ].join("\n");
  await fs.writeFile(path.join(chatsDir, "chat-001.jsonl"), chat1Messages);

  // Chat 2 messages
  const chat2Messages = [
    JSON.stringify({ role: "user", content: "Test message", timestamp: "2025-01-02T00:00:00Z" }),
  ].join("\n");
  await fs.writeFile(path.join(chatsDir, "chat-002.jsonl"), chat2Messages);

  // Create V1 document data
  const dataDir = path.join(v1Root, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const documents = [
    {
      id: "doc-001",
      title: "My Document",
      content: "# Hello\n\nThis is my document.",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T12:00:00Z",
      favorite: true,
      tags: ["test", "migration"],
    },
    {
      id: "doc-002",
      title: "Second Doc",
      content: "Some content",
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    },
  ];
  await fs.writeFile(
    path.join(dataDir, "documents.json"),
    JSON.stringify(documents),
  );

  // Create V1 app data
  const apps = [
    {
      id: "app-001",
      name: "My App",
      description: "A test app",
      createdAt: "2025-01-01T00:00:00Z",
    },
  ];
  await fs.writeFile(
    path.join(dataDir, "apps.json"),
    JSON.stringify(apps),
  );

  // Create V1 app files
  const appsDir = path.join(v1Root, "apps", "app-001");
  await fs.mkdir(appsDir, { recursive: true });
  await fs.writeFile(path.join(appsDir, "index.html"), "<h1>Hello App</h1>");
  await fs.writeFile(path.join(appsDir, "style.css"), "body { color: red; }");

  return v1Root;
}

describe("V1 Migration (settings:migrate-v1)", () => {
  test("migrates chats, documents, and apps from V1 structure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-migration-test-"));
    tmpRoots.push(root);

    // Override HOME so migration reads from our temp dir
    const originalHome = os.homedir;
    vi.spyOn(os, "homedir").mockReturnValue(root);

    await setupV1Data(root);

    const { ws, sent } = createMockWs();
    const message: WSMessage = {
      id: "test-migration-1",
      type: "settings:migrate-v1",
      payload: {},
    };

    await setupSettingsHandlers(ws as never, message);

    // Should have sent one response
    expect(sent).toHaveLength(1);
    const response = JSON.parse(sent[0].data) as {
      id: string;
      success: boolean;
      data: {
        chats: { migrated: number; messages: number };
        documents: { migrated: number };
        apps: { migrated: number };
      };
    };

    expect(response.id).toBe("test-migration-1");
    expect(response.success).toBe(true);

    // Check migration counts
    expect(response.data.chats.migrated).toBe(2);
    expect(response.data.chats.messages).toBe(4); // 3 + 1
    expect(response.data.documents.migrated).toBe(2);
    expect(response.data.apps.migrated).toBe(1);

    // Verify documents on disk
    const v2DocsDir = path.join(root, "Papr", "documents");
    const doc1Content = await fs.readFile(
      path.join(v2DocsDir, "doc-001", "content.md"),
      "utf-8",
    );
    expect(doc1Content).toBe("# Hello\n\nThis is my document.");

    const doc1Meta = JSON.parse(
      await fs.readFile(path.join(v2DocsDir, "doc-001", "meta.json"), "utf-8"),
    ) as { title: string; favorite: boolean; tags: string[] };
    expect(doc1Meta.title).toBe("My Document");
    expect(doc1Meta.favorite).toBe(true);
    expect(doc1Meta.tags).toEqual(["test", "migration"]);

    // Verify versions directory was created
    const versionsDir = path.join(v2DocsDir, "doc-001", "versions");
    const versionsStat = await fs.stat(versionsDir);
    expect(versionsStat.isDirectory()).toBe(true);

    // Verify app files were copied
    const v2AppsDir = path.join(root, "Papr", "apps");
    const appIndex = JSON.parse(
      await fs.readFile(path.join(v2AppsDir, "app-001", "index.json"), "utf-8"),
    ) as { id: string; name: string };
    expect(appIndex.name).toBe("My App");

    const appHtml = await fs.readFile(
      path.join(v2AppsDir, "app-001", "index.html"),
      "utf-8",
    );
    expect(appHtml).toBe("<h1>Hello App</h1>");

    const appCss = await fs.readFile(
      path.join(v2AppsDir, "app-001", "style.css"),
      "utf-8",
    );
    expect(appCss).toBe("body { color: red; }");

    vi.mocked(os.homedir).mockRestore();
  });

  test("handles missing V1 data gracefully", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-migration-empty-"));
    tmpRoots.push(root);

    vi.spyOn(os, "homedir").mockReturnValue(root);

    // Don't create any V1 data

    const { ws, sent } = createMockWs();
    const message: WSMessage = {
      id: "test-migration-2",
      type: "settings:migrate-v1",
      payload: {},
    };

    await setupSettingsHandlers(ws as never, message);

    expect(sent).toHaveLength(1);
    const response = JSON.parse(sent[0].data) as {
      success: boolean;
      data: {
        chats: { migrated: number; messages: number };
        documents: { migrated: number };
        apps: { migrated: number };
      };
    };

    expect(response.success).toBe(true);
    expect(response.data.chats.migrated).toBe(0);
    expect(response.data.documents.migrated).toBe(0);
    expect(response.data.apps.migrated).toBe(0);

    vi.mocked(os.homedir).mockRestore();
  });

  test("skips malformed chat messages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-migration-malformed-"));
    tmpRoots.push(root);

    vi.spyOn(os, "homedir").mockReturnValue(root);

    const v1Root = path.join(root, ".paprwork");
    const chatsDir = path.join(v1Root, "chats");
    await fs.mkdir(chatsDir, { recursive: true });

    await fs.writeFile(
      path.join(chatsDir, "index.json"),
      JSON.stringify({ chats: [{ id: "chat-bad", title: "Bad Chat" }] }),
    );

    const badMessages = [
      "not valid json",
      JSON.stringify({ role: "system", content: "should skip system" }),
      JSON.stringify({ role: "user", content: 12345 }), // content not string
      JSON.stringify({ role: "user", content: "Valid message" }),
      "",
    ].join("\n");
    await fs.writeFile(path.join(chatsDir, "chat-bad.jsonl"), badMessages);

    const { ws, sent } = createMockWs();
    const message: WSMessage = {
      id: "test-migration-3",
      type: "settings:migrate-v1",
      payload: {},
    };

    await setupSettingsHandlers(ws as never, message);

    const response = JSON.parse(sent[0].data) as {
      data: { chats: { migrated: number; messages: number } };
    };

    expect(response.data.chats.migrated).toBe(1);
    expect(response.data.chats.messages).toBe(1); // Only the valid message
    
    vi.mocked(os.homedir).mockRestore();
  });
});
