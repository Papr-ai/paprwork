import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateway } from "../ui/src/lib/gateway";
import { useTabStore } from "../ui/stores/tabStore";
import { useChatStore } from "../ui/stores/chatStore";
import {
  reloadUiForWorkspaceSwitch,
  resetWorkspaceReloadForTests,
} from "../ui/lib/workspaceSwitchReload";

const gatewaySendMock = vi.fn(async (type: string) => {
  if (type === "chat:list") {
    return { success: true, data: [{ id: "chat-1", title: "Hi", createdAt: "", updatedAt: "" }] };
  }
  if (type === "app:load_tabs") {
    return {
      success: true,
      data: [
        {
          id: "tab-chat-1",
          type: "chat",
          entityId: "chat-1",
          title: "Hi",
          displayMode: "standalone",
          parentTabId: null,
          position: 0,
          isFavorite: false,
        },
      ],
    };
  }
  if (type === "app:load_state") {
    return {
      success: true,
      data: { activeTabId: "tab-chat-1", splitRatio: 0.5, history: [], historyIndex: -1 },
    };
  }
  if (type === "document:list" || type === "app:list") {
    return { success: true, data: [] };
  }
  return { success: true, data: undefined };
});

vi.mock("../ui/src/lib/gateway", () => ({
  gateway: {
    send: (...args: unknown[]) => gatewaySendMock(...args),
  },
}));

function stubWindowForReload(): void {
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(() => true),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("CustomEvent", class CustomEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  });
  vi.stubGlobal("localStorage", {
    removeItem: vi.fn(),
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
}

describe("reloadUiForWorkspaceSwitch", () => {
  beforeEach(() => {
    resetWorkspaceReloadForTests();
    gatewaySendMock.mockClear();
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      history: [],
      historyIndex: -1,
    });
    useChatStore.getState().resetForWorkspaceSwitch();
  });

  afterEach(() => {
    resetWorkspaceReloadForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("coalesces concurrent reload calls into one in-flight run", async () => {
    vi.useFakeTimers();
    stubWindowForReload();

    const first = reloadUiForWorkspaceSwitch();
    const second = reloadUiForWorkspaceSwitch();

    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    const reloadEvents = vi
      .mocked(window.dispatchEvent)
      .mock.calls.filter(([event]) => (event as { type?: string }).type === "papr-workspace-reload");
    expect(reloadEvents).toHaveLength(1);
  });

  it("loads tabs from SQLite before chat:list validation", async () => {
    vi.useFakeTimers();
    stubWindowForReload();

    const callOrder: string[] = [];
    gatewaySendMock.mockImplementation(async (type: string) => {
      callOrder.push(type);
      if (type === "chat:list") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          success: true,
          data: [{ id: "chat-1", title: "Hi", createdAt: "", updatedAt: "" }],
        };
      }
      if (type === "app:load_tabs") {
        return {
          success: true,
          data: [
            {
              id: "tab-chat-1",
              type: "chat",
              entityId: "chat-1",
              title: "Hi",
              displayMode: "standalone",
              parentTabId: null,
              position: 0,
              isFavorite: false,
            },
          ],
        };
      }
      if (type === "app:load_state") {
        return {
          success: true,
          data: { activeTabId: "tab-chat-1", splitRatio: 0.5, history: [], historyIndex: -1 },
        };
      }
      return { success: true, data: undefined };
    });

    const reloadPromise = reloadUiForWorkspaceSwitch();
    await vi.runAllTimersAsync();
    await reloadPromise;

    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useTabStore.getState().tabs[0]?.title).toBe("Hi");

    const tabsIndex = callOrder.indexOf("app:load_tabs");
    const chatIndex = callOrder.indexOf("chat:list");
    expect(tabsIndex).toBeGreaterThanOrEqual(0);
    expect(chatIndex).toBeGreaterThan(tabsIndex);

    await vi.advanceTimersByTimeAsync(500);
    expect(useChatStore.getState().chats).toHaveLength(1);
  });
});
