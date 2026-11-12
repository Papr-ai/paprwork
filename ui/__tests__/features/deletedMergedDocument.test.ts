/**
 * Repro: deleting a document that is merged into a chat must not leave the
 * chat merged with a dead tab ("Document not found" stuck in the side panel).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../../stores/tabStore";
import { useArtifactsStore } from "../../stores/artifactsStore";

describe("Deleting a document merged into a chat", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [], activeTabId: null, splitRatio: 0.5, isSplitView: false,
      activeLeftTab: null, activeRightTab: null, history: [], historyIndex: -1,
    });
    (global as any).window = (global as any).window ?? {};
    (global.window as any).__chatStore__ = null;
  });

  it("removes the doc tab and unmerges the chat when the artifact is removed", () => {
    const s = () => useTabStore.getState();
    const chat = s().createTab("chat", "chat-1", "Chat");
    const doc = s().createTab("document", "doc-1", "Pitch");
    s().addChild(chat, doc, "right");
    expect(s().getTab(chat)?.childTabIds).toContain(doc);

    // What useArtifacts.deleteArtifact does after document:delete succeeds
    useArtifactsStore.getState().removeArtifact("doc-1");

    expect(s().getTab(doc)).toBeUndefined();
    expect(s().getTab(chat)?.childTabIds ?? []).not.toContain(doc);
    expect(s().getTab(chat)?.displayMode).toBe("standalone");
  });
});
