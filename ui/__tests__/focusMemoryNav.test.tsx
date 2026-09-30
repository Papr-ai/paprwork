/**
 * Focus and Memory are separate destinations: the rail agent opens Focus, the rail Memory item
 * opens Memory, and ⌘K opened from either starts scoped to the agent's memory (removable).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../src/lib/gateway", () => ({
  gateway: {
    send: vi.fn(async (method: string) =>
      method === "memory:wiki-search"
        ? { success: true, data: { results: [{ id: "ada", type: "people", label: "Ada Lovelace" }] } }
        : { success: true, data: [] },
    ),
    onConnectionChange: () => () => {},
  },
}));

import { useTabStore } from "../stores/tabStore";
import { switchToFocusTab, switchToMemoryTab } from "../lib/ensureDefaultChatTab";
import { isLegacyFocusRow } from "../lib/persistedAppState";
import { scopeForActiveTab } from "../components/CommandPalette/usePaletteScope";
import { CommandPalette } from "../components/CommandPalette/CommandPalette";
import { takePendingMemoryEntity } from "../lib/memoryNav";

function resetTabs() {
  useTabStore.setState({ tabs: [], activeTabId: null, activeLeftTab: null, activeRightTab: null, history: [], historyIndex: -1 });
}

describe("Focus / Memory tabs", () => {
  beforeEach(resetTabs);

  it("opens one Focus tab and one Memory tab, and reuses them", () => {
    const focus = switchToFocusTab();
    const memory = switchToMemoryTab();
    expect(switchToFocusTab()).toBe(focus);
    expect(switchToMemoryTab()).toBe(memory);
    const { tabs, activeTabId } = useTabStore.getState();
    expect(tabs.map((t) => [t.type, t.title])).toEqual([
      ["focus", "Focus"],
      ["memory", "Memory"],
    ]);
    expect(activeTabId).toBe(memory);
  });

  it("migrates the old Home tab (memory type titled Home) to Focus", () => {
    expect(isLegacyFocusRow({ type: "memory", title: "Home" })).toBe(true);
    expect(isLegacyFocusRow({ type: "memory", title: "Memory" })).toBe(false);
    expect(isLegacyFocusRow({ type: "chat", title: "Home" })).toBe(false);
  });

  it("scopes search to where you are", () => {
    switchToFocusTab();
    expect(scopeForActiveTab()).toEqual({ id: "focus", label: "Focus" });
    switchToMemoryTab();
    expect(scopeForActiveTab()).toEqual({ id: "memory", label: "Memory" });
    useTabStore.getState().switchToTab(useTabStore.getState().createTab("apps", "apps", "Apps"));
    expect(scopeForActiveTab()).toBeNull();
  });
});

describe("⌘K scope chip", () => {
  beforeEach(() => {
    resetTabs();
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  });

  it("starts scoped on Focus and opens a memory result on the Memory page", async () => {
    vi.useFakeTimers();
    switchToFocusTab();
    render(<CommandPalette isOpen onClose={() => {}} />);
    expect(screen.getByText("Focus", { selector: ".cmd-palette__scope" })).toBeTruthy();

    const input = screen.getByLabelText("Search");
    fireEvent.change(input, { target: { value: "ada" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText("In Focus")).toBeTruthy();
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(useTabStore.getState().tabs.some((t) => t.type === "memory")).toBe(true);
    expect(takePendingMemoryEntity()?.label).toBe("Ada Lovelace");
    vi.useRealTimers();
  });

  it("removes the scope with Backspace on an empty query", () => {
    switchToMemoryTab();
    const { container } = render(<CommandPalette isOpen onClose={() => {}} />);
    expect(container.querySelector(".cmd-palette__scope")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Backspace" });
    expect(container.querySelector(".cmd-palette__scope")).toBeNull();
  });
});
