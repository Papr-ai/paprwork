/**
 * ⌘K sections: empty query shows Continue (latest chat, app, doc), Pinned, and Go to;
 * typing searches chats/apps/docs by title; ⌘↵ opens an app beside the chat on screen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../src/lib/gateway", () => ({
  gateway: {
    send: vi.fn(async () => ({ success: true, data: [] })),
    onConnectionChange: () => () => {},
  },
}));
// The palette refreshes artifacts on open; keep the seeded list instead of the mocked empty one.
vi.mock("../hooks/useArtifacts", () => ({ useArtifacts: () => ({ artifacts: [], loadArtifacts: vi.fn() }) }));

import { useTabStore } from "../stores/tabStore";
import { useChatStore } from "../stores/chatStore";
import { useArtifactsStore, type Artifact } from "../stores/artifactsStore";
import { CommandPalette } from "../components/CommandPalette/CommandPalette";

const CHAT = "3f1c2a90-0000-4000-8000-000000000001";
const OLD_CHAT = "3f1c2a90-0000-4000-8000-000000000002";

function seed() {
  useTabStore.setState({ tabs: [], activeTabId: null, activeLeftTab: null, activeRightTab: null, history: [], historyIndex: -1 });
  useChatStore.setState({
    chats: [
      { id: CHAT, title: "Help me redesign our left navigation", createdAt: "", updatedAt: "2026-09-28T21:00:00Z", messageCount: 4 },
      { id: OLD_CHAT, title: "Older chat", createdAt: "", updatedAt: "2026-09-20T10:00:00Z", messageCount: 2 },
    ],
  });
  useArtifactsStore.setState({
    artifacts: [
      { id: "app-train", title: "Stage A Training Monitor", type: "app", updatedAt: "2026-09-28T20:00:00Z" },
      { id: "app-meet", title: "Meetings Manager", type: "app", updatedAt: "2026-09-01T00:00:00Z", favorite: true, icon: "data:image/png;base64,MEET" },
      { id: "doc-memo", title: "Papr Investment Memo", type: "document", updatedAt: "2026-09-27T00:00:00Z", favorite: true },
    ] as unknown as Artifact[],
  });
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll(".cmd-palette__section-label")].map((n) => n.textContent);

describe("⌘K sections", () => {
  beforeEach(() => {
    seed();
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  });

  it("opens on Continue, Pinned, Go to, with keyboard hints in the footer", () => {
    const { container } = render(<CommandPalette isOpen onClose={() => {}} />);
    expect(labels(container)).toEqual(["Continue", "Pinned", "Go to"]);
    const rows = [...container.querySelectorAll(".cmd-palette__item-label")].map((n) => n.textContent);
    // Latest chat, app, doc, in that order. The memo is pinned but also latest doc, so it shows once.
    expect(rows.slice(0, 4)).toEqual([
      "Help me redesign our left navigation",
      "Stage A Training Monitor",
      "Papr Investment Memo",
      "Meetings Manager",
    ]);
    expect(rows.filter((r) => r === "Papr Investment Memo")).toHaveLength(1);
    expect(container.querySelector(".cmd-palette__foot")?.textContent).toContain("open beside chat");
  });

  it("shows an app's own icon, like the Apps grid, and the kind glyph when it has none", () => {
    const { container } = render(<CommandPalette isOpen onClose={() => {}} />);
    const row = (title: string) =>
      [...container.querySelectorAll(".cmd-palette__item")].find((b) => b.textContent?.includes(title))!;
    expect(row("Meetings Manager").querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,MEET");
    expect(row("Stage A Training Monitor").querySelector("img")).toBeNull();
    expect(row("Stage A Training Monitor").querySelector("svg")).toBeTruthy();
  });

  it("searches chats, apps, and docs by title", () => {
    const { container } = render(<CommandPalette isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "older" } });
    expect(labels(container)).toEqual(["Results"]);
    expect(screen.getByText("Older chat")).toBeTruthy();
  });

  it("⌘↵ opens an app beside the chat on screen", () => {
    const { createTab, switchToTab } = useTabStore.getState();
    const chatTab = createTab("chat", CHAT, "Help me redesign our left navigation");
    switchToTab(chatTab);
    render(<CommandPalette isOpen onClose={() => {}} />);
    const input = screen.getByLabelText("Search");
    fireEvent.change(input, { target: { value: "stage a" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    const app = useTabStore.getState().tabs.find((t) => t.type === "app");
    expect(app?.parentTabId).toBe(chatTab);
  });
});
