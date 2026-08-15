import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateway } from "../ui/src/lib/gateway";
import { useTabStore } from "../ui/stores/tabStore";
import { useChatStore } from "../ui/stores/chatStore";
import {
  reloadUiForWorkspaceSwitch,
  resetWorkspaceReloadForTests,
  attachWorkspaceSwitchBroadcastListener,
  isWorkspaceSwitchReloading,
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
  const listeners = new Map<string, Set<EventListener>>();
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn((event: Event) => {
      listeners.get(event.type)?.forEach((handler) => {
        handler(event);
      });
      return true;
    }),
    addEventListener: vi.fn((type: string, handler: EventListener) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: EventListener) => {
      listeners.get(type)?.delete(handler);
    }),
  });
  vi.stubGlobal("CustomEvent", class CustomEvent<T = unknown> extends Event {
    detail: T;
    constructor(type: string, init?: { detail?: T }) {
      super(type);
      this.detail = init?.detail as T;
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

  it("loads workspace entities before SQLite tab restore", async () => {
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

    expect(useTabStore.getState().tabs).toHaveLength(2);
    expect(useTabStore.getState().tabs.some((tab) => tab.title === "Hi")).toBe(true);
    expect(useTabStore.getState().activeTabId).toBe("settings-settings");

    const tabsIndex = callOrder.indexOf("app:load_tabs");
    const chatIndex = callOrder.indexOf("chat:list");
    expect(tabsIndex).toBeGreaterThanOrEqual(0);
    expect(chatIndex).toBeGreaterThanOrEqual(0);
    expect(tabsIndex).toBeGreaterThan(chatIndex);

    expect(useChatStore.getState().chats).toHaveLength(1);
  });

  it("retries tab load when gateway switch completes after an empty early load", async () => {
    vi.useFakeTimers();
    stubWindowForReload();

    let loadTabsCalls = 0;
    gatewaySendMock.mockImplementation(async (type: string) => {
      if (type === "app:load_tabs") {
        loadTabsCalls += 1;
        if (loadTabsCalls === 1) {
          return { success: true, data: [] };
        }
        return {
          success: true,
          data: [
            {
              id: "tab-chat-1",
              type: "chat",
              entityId: "chat-1",
              title: "Saved chat",
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
          data: {
            activeTabId: loadTabsCalls > 1 ? "tab-chat-1" : null,
            splitRatio: 0.5,
            history: [],
            historyIndex: -1,
          },
        };
      }
      if (type === "chat:list") {
        return {
          success: true,
          data: [{ id: "chat-1", title: "Saved chat", createdAt: "", updatedAt: "" }],
        };
      }
      return { success: true, data: undefined };
    });

    const reloadPromise = reloadUiForWorkspaceSwitch();
    await vi.runAllTimersAsync();
    await reloadPromise;

    expect(useTabStore.getState().tabs.filter((t) => t.type !== "settings")).toHaveLength(
      0,
    );

    attachWorkspaceSwitchBroadcastListener();
    window.dispatchEvent(
      new CustomEvent("gateway-broadcast", {
        detail: { type: "workspace:switch-complete", data: {} },
      }),
    );
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(loadTabsCalls).toBeGreaterThanOrEqual(2);
    expect(
      useTabStore.getState().tabs.some((tab) => tab.title === "Saved chat"),
    ).toBe(true);
  });

  it("waitForGateway keeps persistence blocked until switch-complete restores tabs", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    const reloadPromise = reloadUiForWorkspaceSwitch({ waitForGateway: true });
    await reloadPromise;

    expect(isWorkspaceSwitchReloading()).toBe(true);

    window.dispatchEvent(
      new CustomEvent("gateway-broadcast", {
        detail: { type: "workspace:switch-complete", data: {} },
      }),
    );
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(isWorkspaceSwitchReloading()).toBe(false);
  });

  it("waitForGateway clears stale tabs and loads new workspace tabs only after switch-complete", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    useTabStore.getState().createTab("app", "old-app-id", "Old org app");

    let loadTabsCalls = 0;
    gatewaySendMock.mockImplementation(async (type: string) => {
      if (type === "app:load_tabs") {
        loadTabsCalls += 1;
        return {
          success: true,
          data: [
            {
              id: "tab-chat-new",
              type: "chat",
              entityId: "chat-new",
              title: "New org chat",
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
          data: {
            activeTabId: "tab-chat-new",
            splitRatio: 0.5,
            history: [],
            historyIndex: -1,
          },
        };
      }
      if (type === "chat:list") {
        return {
          success: true,
          data: [{ id: "chat-new", title: "New org chat", createdAt: "", updatedAt: "" }],
        };
      }
      return { success: true, data: undefined };
    });

    const reloadPromise = reloadUiForWorkspaceSwitch({ waitForGateway: true });
    await reloadPromise;

    expect(useTabStore.getState().tabs.some((tab) => tab.title === "Old org app")).toBe(
      false,
    );
    expect(loadTabsCalls).toBe(0);

    window.dispatchEvent(
      new CustomEvent("gateway-broadcast", {
        detail: { type: "workspace:switch-complete", data: {} },
      }),
    );
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(loadTabsCalls).toBeGreaterThanOrEqual(1);
    expect(
      useTabStore.getState().tabs.some((tab) => tab.title === "New org chat"),
    ).toBe(true);
    expect(
      useTabStore.getState().tabs.some((tab) => tab.title === "Old org app"),
    ).toBe(false);
  });
});
