/**
 * A tab bar that could not be read must never be written back over.
 *
 * The bug these cover: a workspace reload clears the tab store, restores from
 * SQLite, and saves whatever the store holds afterwards. `app:save_tabs` is
 * DELETE-then-insert, so when the restore could not read SQLite, the scaffolding
 * that accumulated in the meantime (a Settings tab) replaced the real rows —
 * permanently, and the reload on next launch then had nothing to restore.
 *
 * The distinction that has to survive is *read failed* versus *result empty*.
 * They produce an identical store, so no test here may assert on tab count as a
 * proxy for the read having worked.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowTabPersistence,
  blockTabPersistence,
  getTabPersistenceBlockReason,
  isTabPersistenceBlocked,
  resetTabPersistenceGuardForTests,
  shouldBlockTabPersistence,
} from "../ui/lib/tabPersistenceGuard";
import { pruneStaleEntityTabs } from "../ui/lib/persistedAppState";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

function readSource(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

/** Strip comments so a static guard cannot be satisfied by the prose explaining it. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

beforeEach(() => {
  resetTabPersistenceGuardForTests();
  vi.restoreAllMocks();
});

describe("shouldBlockTabPersistence", () => {
  it("blocks when the saved tab bar could not be read", () => {
    expect(shouldBlockTabPersistence({ status: "unreadable" })).toBe(true);
  });

  it("allows a read that legitimately returned no tabs", () => {
    // The case the whole fix turns on: a workspace with no saved tabs must stay
    // writable, or it could never persist its first tab. Emptiness is not the
    // signal — only the read outcome is.
    expect(shouldBlockTabPersistence({ status: "loaded", tabCount: 0 })).toBe(false);
  });

  it("allows a read that returned tabs", () => {
    expect(shouldBlockTabPersistence({ status: "loaded", tabCount: 7 })).toBe(false);
  });
});

describe("the block latch", () => {
  it("starts open", () => {
    expect(isTabPersistenceBlocked()).toBe(false);
    expect(getTabPersistenceBlockReason()).toBeNull();
  });

  it("holds until a successful read clears it", () => {
    blockTabPersistence("gateway declined the read");
    expect(isTabPersistenceBlocked()).toBe(true);
    expect(getTabPersistenceBlockReason()).toBe("gateway declined the read");

    allowTabPersistence();
    expect(isTabPersistenceBlocked()).toBe(false);
  });

  it("does not expire on its own", async () => {
    // A block that timed out would restore exactly the failure it exists to
    // prevent, just later and harder to trace.
    vi.useFakeTimers();
    blockTabPersistence("gateway declined the read");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(isTabPersistenceBlocked()).toBe(true);
    vi.useRealTimers();
  });

  it("logs a repeated block once, so a retry loop does not flood the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    blockTabPersistence("same reason");
    blockTabPersistence("same reason");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs a new reason even while already blocked", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    blockTabPersistence("first reason");
    blockTabPersistence("second reason");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(getTabPersistenceBlockReason()).toBe("second reason");
  });

  it("is quiet when allow is called on an already-open latch", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    allowTabPersistence();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("pruneStaleEntityTabs treats absent and empty differently", () => {
  const tab = (id: string, type: string, entityId: string) => ({
    id,
    type,
    entityId,
    displayMode: "standalone" as const,
    parentTabId: null,
    childTabIds: [] as string[],
  });

  const tabs = [
    tab("chat-a", "chat", "a"),
    tab("app-b", "app", "b"),
    tab("doc-c", "document", "c"),
    tab("settings", "settings", "settings"),
  ];

  it("keeps everything when no id sets are supplied", () => {
    // This is the semantics the loader fix depends on: an unknown list must
    // leave its tabs alone.
    expect(pruneStaleEntityTabs(tabs, {})).toHaveLength(4);
  });

  it("drops every tab of a kind whose id set is empty", () => {
    // And this is why a failed load must not be reported as an empty set.
    const kept = pruneStaleEntityTabs(tabs, {
      validChatIds: new Set<string>(),
      validAppIds: new Set<string>(),
      validDocumentIds: new Set<string>(),
    });
    expect(kept.map((t) => t.id)).toEqual(["settings"]);
  });

  it("prunes only the kinds it was given", () => {
    const kept = pruneStaleEntityTabs(tabs, { validChatIds: new Set<string>() });
    expect(kept.map((t) => t.id)).toEqual(["app-b", "doc-c", "settings"]);
  });
});

describe("read outcome is derived from the response, not the row count", () => {
  const source = stripComments(readSource("ui/lib/persistedAppState.ts"));

  it("sets tabsReadOk from success + shape, never from data.length", () => {
    expect(source).toContain(
      "const tabsReadOk = tabsResponse.success === true && Array.isArray(tabsResponse.data)",
    );
    // A length check here would collapse the two cases back together.
    expect(source).not.toMatch(/tabsReadOk\s*=[^;]*\.length/);
  });

  it("returns tabsReadOk on the snapshot", () => {
    expect(source).toContain("tabsReadOk,");
  });
});

describe("every destructive tab write consults the guard", () => {
  it("the debounced save checks before scheduling and again inside the callback", () => {
    // The block can land during the debounce window, so a single check at
    // schedule time would let an already-doomed save through.
    const source = stripComments(readSource("ui/hooks/useAppStatePersistence.ts"));
    const checks = source.match(/isTabPersistenceBlocked\(\)/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);

    const scheduleIndex = source.indexOf("scheduleTabStructureSave(");
    expect(scheduleIndex).toBeGreaterThan(-1);
    const beforeSchedule = source.slice(0, scheduleIndex);
    const afterSchedule = source.slice(scheduleIndex);
    expect(beforeSchedule).toContain("isTabPersistenceBlocked()");
    expect(afterSchedule).toContain("isTabPersistenceBlocked()");
  });

  it("the pre-switch flush checks before writing", () => {
    // This one runs at the moment the user leaves the workspace, so a write
    // here makes the loss permanent with no further chance to recover.
    const source = stripComments(readSource("ui/lib/persistedAppState.ts"));
    const flushIndex = source.indexOf("export async function flushWorkspaceStateToGateway");
    expect(flushIndex).toBeGreaterThan(-1);
    const flushBody = source.slice(flushIndex, flushIndex + 1200);
    const guardIndex = flushBody.indexOf("isTabPersistenceBlocked()");
    const writeIndex = flushBody.indexOf('gateway.send("app:save_tabs"');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(writeIndex);
  });

  it("a failed startup read blocks rather than falling through to a save", () => {
    const source = stripComments(readSource("ui/hooks/useAppStatePersistence.ts"));
    expect(source).toMatch(/\.catch\([\s\S]{0,240}blockTabPersistence\(/);
  });
});

describe("entity id sets report unknown lists as unknown", () => {
  const source = stripComments(readSource("ui/lib/workspaceSwitchReload.ts"));

  it("leaves each set undefined when its list failed to load", () => {
    for (const [flag, field] of [
      ["chatsLoaded", "validChatIds"],
      ["appsLoaded", "validAppIds"],
      ["documentsLoaded", "validDocumentIds"],
    ] as const) {
      const index = source.indexOf(`${field}: outcome.${flag}`);
      expect(index, `${field} must be gated on ${flag}`).toBeGreaterThan(-1);
      expect(source.slice(index, index + 400)).toContain("undefined");
    }
  });

  it("keeps the two artifact lists separate", () => {
    // They are fetched independently, so one arriving must not vouch for the
    // other — that is what previously authorised pruning every app tab.
    expect(source).toContain("appsLoaded: apps !== null");
    expect(source).toContain("documentsLoaded: documents !== null");
  });

  it("retries a declined tab read instead of accepting the empty snapshot", () => {
    expect(source).toContain("snapshot.tabsReadOk");
  });
});
