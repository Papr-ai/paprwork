import { describe, expect, test } from "vitest";
import { pruneStaleEntityTabs } from "../ui/lib/persistedAppState";

describe("pruneStaleEntityTabs", () => {
  const tabs = [
    {
      id: "chat-a",
      type: "chat",
      entityId: "chat-a",
      parentTabId: null,
      childTabIds: [],
    },
    {
      id: "app-old",
      type: "app",
      entityId: "app-old",
      parentTabId: null,
      childTabIds: [],
    },
    {
      id: "doc-old",
      type: "document",
      entityId: "doc-old",
      parentTabId: null,
      childTabIds: [],
    },
    {
      id: "app-new",
      type: "app",
      entityId: "app-new",
      parentTabId: "chat-a",
      childTabIds: [],
    },
  ];

  test("removes chats, apps, and documents not in the active workspace", () => {
    const result = pruneStaleEntityTabs(tabs, {
      validChatIds: new Set(["chat-a"]),
      validAppIds: new Set(["app-new"]),
      validDocumentIds: new Set(["doc-new"]),
    });

    expect(result.map((tab) => tab.id)).toEqual(["chat-a", "app-new"]);
    expect(result.find((tab) => tab.id === "app-new")?.parentTabId).toBe(
      "chat-a",
    );
  });

  test("drops child tabs when parent is removed", () => {
    const splitTabs = [
      {
        id: "chat-a",
        type: "chat",
        entityId: "chat-a",
        parentTabId: null,
        childTabIds: ["app-old"],
      },
      {
        id: "app-old",
        type: "app",
        entityId: "app-old",
        parentTabId: "chat-a",
        childTabIds: [],
      },
    ];

    const result = pruneStaleEntityTabs(splitTabs, {
      validChatIds: new Set(["chat-a"]),
      validAppIds: new Set([]),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("chat-a");
    expect(result[0]?.childTabIds).toEqual([]);
  });
});
