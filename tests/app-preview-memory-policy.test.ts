import { describe, expect, test } from "vitest";

import type { Tab } from "../ui/types/tabs";
import {
  effectiveMaxMountedAppPreviews,
  selectMountedAppTabIds,
} from "../ui/utils/appPreviewMemoryPolicy";

function appTab(id: string): Tab {
  return {
    id,
    type: "app",
    entityId: `entity-${id}`,
    title: id,
    displayMode: "standalone",
    childTabIds: [],
    metadata: {},
  };
}

describe("selectMountedAppTabIds", () => {
  test("always keeps visible app tabs mounted", () => {
    const tabs = [appTab("a"), appTab("b"), appTab("c"), appTab("d")];
    const visible = new Set(["a", "b"]);
    const lastActive = new Map<string, number>([
      ["c", 300],
      ["d", 100],
    ]);

    const mounted = selectMountedAppTabIds(tabs, visible, lastActive, 3);
    expect(mounted.has("a")).toBe(true);
    expect(mounted.has("b")).toBe(true);
    expect(mounted.has("c")).toBe(true);
    expect(mounted.has("d")).toBe(false);
  });

  test("raises cap for split view so one hidden tab stays warm", () => {
    const tabs = [appTab("a"), appTab("b"), appTab("c"), appTab("d")];
    const visible = new Set(["a", "b", "c"]);
    const lastActive = new Map<string, number>([
      ["d", 500],
    ]);

    expect(effectiveMaxMountedAppPreviews(visible.size)).toBe(7);
    const mounted = selectMountedAppTabIds(tabs, visible, lastActive);
    expect(mounted.has("a")).toBe(true);
    expect(mounted.has("b")).toBe(true);
    expect(mounted.has("c")).toBe(true);
    expect(mounted.has("d")).toBe(true);
  });

  test("keeps most recently used hidden tabs within the cap", () => {
    const tabs = [appTab("a"), appTab("b"), appTab("c")];
    const visible = new Set<string>();
    const lastActive = new Map<string, number>([
      ["a", 100],
      ["b", 300],
      ["c", 200],
    ]);

    const mounted = selectMountedAppTabIds(tabs, visible, lastActive, 2);
    expect([...mounted].sort()).toEqual(["b", "c"]);
  });
});
