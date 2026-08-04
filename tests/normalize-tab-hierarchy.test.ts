import { describe, expect, it } from "vitest";
import { normalizeTabHierarchy } from "../ui/lib/persistedAppState";

describe("normalizeTabHierarchy", () => {
  it("promotes orphan child tabs to standalone", () => {
    const tabs = normalizeTabHierarchy([
      {
        id: "app-deck",
        type: "app",
        entityId: "deck-id",
        title: "Deck Studio",
        displayMode: "child",
        parentTabId: null,
        childTabIds: [],
      },
    ]);

    expect(tabs[0]?.displayMode).toBe("standalone");
    expect(tabs[0]?.parentTabId).toBeNull();
  });

  it("promotes child when parent tab was removed", () => {
    const tabs = normalizeTabHierarchy([
      {
        id: "app-deck",
        type: "app",
        entityId: "deck-id",
        title: "Deck Studio",
        displayMode: "child",
        parentTabId: "chat-missing",
        childTabIds: [],
      },
    ]);

    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.displayMode).toBe("standalone");
    expect(tabs[0]?.parentTabId).toBeNull();
  });
});
