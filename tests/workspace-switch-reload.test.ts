import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateway } from "../ui/src/lib/gateway";
import { useTabStore } from "../ui/stores/tabStore";
import { useChatStore } from "../ui/stores/chatStore";
import {
  reloadUiForWorkspaceSwitch,
  resetWorkspaceReloadForTests,
  attachWorkspaceSwitchBroadcastListener,
  isWorkspaceSwitchReloading,
  prepareWorkspaceSwitchReload,
} from "../ui/lib/workspaceSwitchReload";
import {
  getWorkspaceSwitchOverlaySnapshot,
  resetWorkspaceSwitchOverlayForTests,
} from "../ui/lib/workspaceSwitchOverlay";
import { writeWorkspaceUiCache, buildWorkspaceUiCacheKey } from "../ui/lib/workspaceUiCache";

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
    resetWorkspaceSwitchOverlayForTests();
    gatewaySendMock.mockClear();
    vi.stubGlobal("fetch", vi.fn());
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

    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useTabStore.getState().tabs.some((tab) => tab.title === "Hi")).toBe(true);
    expect(useTabStore.getState().activeTabId).toBe("tab-chat-1");

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
          throw new Error("AppStateStorage not ready");
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

    const reloadPromise = reloadUiForWorkspaceSwitch({ waitForGateway: true });
    await reloadPromise;

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

  it("prepareWorkspaceSwitchReload flushes leaving workspace tabs before clearing UI", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    useTabStore.getState().createTab("chat", "chat-leave", "Leaving chat");
    useTabStore.getState().createTab("app", "app-leave", "Leaving app");

    const saveTabsCalls: Array<{ length: number; titles: string[] }> = [];
    gatewaySendMock.mockImplementation(async (type: string, payload?: unknown) => {
      if (type === "app:save_tabs") {
        const tabs = Array.isArray(payload)
          ? (payload as Array<{ title: string }>)
          : [];
        saveTabsCalls.push({
          length: tabs.length,
          titles: tabs.map((tab) => tab.title),
        });
        return { success: true };
      }
      if (type === "app:save_state") {
        return { success: true };
      }
      if (type === "app:load_tabs") {
        return { success: true, data: [] };
      }
      if (type === "app:load_state") {
        return {
          success: true,
          data: { activeTabId: null, splitRatio: 0.5, history: [], historyIndex: -1 },
        };
      }
      if (type === "chat:list") {
        return { success: true, data: [] };
      }
      return { success: true, data: undefined };
    });

    const reloadPromise = prepareWorkspaceSwitchReload({
      organizationName: "Acme",
      namespaceName: "Production",
      targetWorkspaceKey: buildWorkspaceUiCacheKey("org-target", "ns-target"),
    });
    await reloadPromise;

    expect(saveTabsCalls.length).toBeGreaterThanOrEqual(1);
    expect(saveTabsCalls[0]?.length).toBeGreaterThanOrEqual(2);
    expect(saveTabsCalls[0]?.titles).toContain("Leaving chat");
    expect(saveTabsCalls[0]?.titles).toContain("Leaving app");
    expect(useTabStore.getState().tabs.some((tab) => tab.title === "Leaving chat")).toBe(
      false,
    );
  });

  it("prepareWorkspaceSwitchReload hydrates target workspace tabs from cache while waiting for gateway", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    const targetKey = buildWorkspaceUiCacheKey("org-target", "ns-target");
    writeWorkspaceUiCache(targetKey, {
      tabs: [
        {
          id: "chat-chat-cached",
          type: "chat",
          entityId: "chat-cached",
          title: "Cached chat",
          displayMode: "standalone",
          parentTabId: null,
          childTabIds: [],
          position: 0,
          isFavorite: false,
        },
      ],
      activeTabId: "chat-chat-cached",
      splitRatio: 0.5,
      splitRatios: {},
      history: [],
      historyIndex: -1,
      artifacts: [],
    });

    gatewaySendMock.mockImplementation(async (type: string) => {
      if (type === "app:save_tabs" || type === "app:save_state") {
        return { success: true };
      }
      if (type === "app:load_tabs") {
        return { success: true, data: [] };
      }
      if (type === "app:load_state") {
        return {
          success: true,
          data: { activeTabId: null, splitRatio: 0.5, history: [], historyIndex: -1 },
        };
      }
      if (type === "chat:list") {
        return { success: true, data: [] };
      }
      return { success: true, data: undefined };
    });

    const reloadPromise = prepareWorkspaceSwitchReload({
      organizationName: "Acme",
      namespaceName: "Production",
      targetWorkspaceKey: targetKey,
    });
    await reloadPromise;

    expect(
      useTabStore.getState().tabs.some((tab) => tab.title === "Cached chat"),
    ).toBe(true);
  });

  it("cold boot reload does not show the workspace switch overlay", async () => {
    stubWindowForReload();

    await reloadUiForWorkspaceSwitch({
      waitForGateway: false,
      targetWorkspaceKey: buildWorkspaceUiCacheKey("org-a", "ns-a"),
      organizationName: "Acme",
      namespaceName: "Production",
    });

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(false);
    expect(isWorkspaceSwitchReloading()).toBe(false);
  });

  it("prepareWorkspaceSwitchReload shows overlay before gateway switch completes", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ active: true, phase: "core" }),
    } as Response);

    const reloadPromise = prepareWorkspaceSwitchReload({
      organizationName: "Acme",
      namespaceName: "Production",
    });
    await reloadPromise;

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(true);
    expect(getWorkspaceSwitchOverlaySnapshot().organizationName).toBe("Acme");
  });

  it("catch-up does not complete reload while gateway is still idle before switch starts", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ active: false, phase: "idle" }),
    } as Response);

    const targetKey = buildWorkspaceUiCacheKey("org-new", "ns-new");
    const reloadPromise = reloadUiForWorkspaceSwitch({
      waitForGateway: true,
      targetWorkspaceKey: targetKey,
      organizationName: "Acme",
      namespaceName: "Production",
    });
    await reloadPromise;
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(true);
    expect(isWorkspaceSwitchReloading()).toBe(true);
  });

  it("catch-up completes reload when gateway switch-status matches target workspace", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        active: false,
        phase: "complete",
        organizationId: "org-new",
        namespaceId: "ns-new",
      }),
    } as Response);

    const targetKey = buildWorkspaceUiCacheKey("org-new", "ns-new");
    const reloadPromise = reloadUiForWorkspaceSwitch({
      waitForGateway: true,
      targetWorkspaceKey: targetKey,
    });
    await reloadPromise;
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(false);
    expect(isWorkspaceSwitchReloading()).toBe(false);
  });

  it("catch-up completes reload when gateway switch-status is already complete", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ active: false, phase: "complete" }),
    } as Response);

    const reloadPromise = reloadUiForWorkspaceSwitch({ waitForGateway: true });
    await reloadPromise;
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(false);
    expect(isWorkspaceSwitchReloading()).toBe(false);
  });

  it("fallback timeout finishes reload and dismisses overlay", async () => {
    vi.useFakeTimers();
    stubWindowForReload();
    attachWorkspaceSwitchBroadcastListener();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ active: true, phase: "services" }),
    } as Response);

    const reloadPromise = reloadUiForWorkspaceSwitch({ waitForGateway: true });
    await reloadPromise;

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.resolve();

    expect(getWorkspaceSwitchOverlaySnapshot().active).toBe(false);
    expect(isWorkspaceSwitchReloading()).toBe(false);
  });
});
