import { describe, expect, test } from "vitest";

import type { Tab } from "../ui/types/tabs";
import { buildTabStructureFingerprint } from "../ui/lib/tabStructureFingerprint";

function tab(partial: Partial<Tab> & Pick<Tab, "id">): Tab {
  return {
    type: "chat",
    entityId: partial.id,
    title: partial.title ?? partial.id,
    displayMode: "standalone",
    parentTabId: null,
    childTabIds: [],
    metadata: {},
    ...partial,
  };
}

describe("buildTabStructureFingerprint", () => {
  test("ignores transient hasUnread / pendingRefresh metadata", () => {
    const a = [tab({ id: "t1", metadata: { hasUnread: true } })];
    const b = [tab({ id: "t1", metadata: { hasUnread: false, pendingRefresh: true } })];
    expect(buildTabStructureFingerprint(a)).toBe(buildTabStructureFingerprint(b));
  });

  test("changes when tab title or order changes", () => {
    const before = [tab({ id: "t1", title: "One" }), tab({ id: "t2", title: "Two" })];
    const after = [tab({ id: "t2", title: "Two" }), tab({ id: "t1", title: "One" })];
    expect(buildTabStructureFingerprint(before)).not.toBe(
      buildTabStructureFingerprint(after),
    );
  });
});
