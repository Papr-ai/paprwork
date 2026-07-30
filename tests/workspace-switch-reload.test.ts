import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabStore } from "../ui/stores/tabStore";
import { useChatStore } from "../ui/stores/chatStore";
import {
  reloadUiForWorkspaceSwitch,
  resetWorkspaceReloadForTests,
} from "../ui/lib/workspaceSwitchReload";

vi.mock("../ui/src/lib/gateway", () => ({
  gateway: {
    send: vi.fn(async (type: string) => {
      if (type === "chat:list") {
        return { success: true, data: [] };
      }
      if (type === "document:list" || type === "app:list") {
        return { success: true, data: [] };
      }
      if (type === "app-state:load") {
        return { success: true, data: { tabs: [], activeTabId: null } };
      }
      return { success: true, data: undefined };
    }),
  },
}));

describe("reloadUiForWorkspaceSwitch", () => {
  beforeEach(() => {
    resetWorkspaceReloadForTests();
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
  });

  it("coalesces concurrent reload calls into one in-flight run", async () => {
    let reloadEventCount = 0;
    const onReload = () => {
      reloadEventCount += 1;
    };
    vi.stubGlobal("window", {
      dispatchEvent: (event: { type?: string }) => {
        if (event.type === "papr-workspace-reload") {
          onReload();
        }
        return true;
      },
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
    });

    const first = reloadUiForWorkspaceSwitch();
    const second = reloadUiForWorkspaceSwitch();

    await Promise.all([first, second]);

    expect(reloadEventCount).toBe(1);
  });
});
