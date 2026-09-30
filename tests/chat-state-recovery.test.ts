/**
 * A mounted chat pane must recover when its store entry is wiped underneath it.
 *
 * The bug these cover: the pane hydrates messages in an effect keyed on chatId,
 * so a wipe of `chatStates` left the pane rendering the welcome screen with the
 * conversation apparently gone. Switching to another tab and back restored it,
 * because that unmounts and remounts the pane and re-runs the hydration effect.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldRehydrateAfterStoreWipe } from "../ui/utils/chatStateRecovery";

const CHAT = "8f2c1d90-4a6b-4c2e-9f11-7d3b5e6a1c04";

describe("shouldRehydrateAfterStoreWipe", () => {
  it("reloads when the entry disappears while the pane is mounted", () => {
    expect(
      shouldRehydrateAfterStoreWipe({
        chatId: CHAT,
        hadEntry: true,
        hasEntry: false,
      }),
    ).toBe(true);
  });

  it("stays quiet while the entry is present", () => {
    expect(
      shouldRehydrateAfterStoreWipe({
        chatId: CHAT,
        hadEntry: true,
        hasEntry: true,
      }),
    ).toBe(false);
  });

  it("does not fire on first mount, when the mount effect already loads", () => {
    expect(
      shouldRehydrateAfterStoreWipe({
        chatId: CHAT,
        hadEntry: false,
        hasEntry: false,
      }),
    ).toBe(false);
  });

  it("settles after the reload recreates the entry, so it cannot loop", () => {
    // The reload always writes an entry back (loadMessages does so in its
    // finally block), which flips hasEntry true and ends the sequence.
    const first = shouldRehydrateAfterStoreWipe({
      chatId: CHAT,
      hadEntry: true,
      hasEntry: false,
    });
    const second = shouldRehydrateAfterStoreWipe({
      chatId: CHAT,
      hadEntry: false,
      hasEntry: true,
    });
    expect([first, second]).toEqual([true, false]);
  });

  it("ignores temp chats, whose entry is removed by id migration", () => {
    // migrateChatId deletes the temp entry, then an await runs before the tab
    // switches to the permanent id — so the pane can render with the temp id
    // and no entry. There is nothing to load for a temp chat.
    expect(
      shouldRehydrateAfterStoreWipe({
        chatId: "temp-1757030000000-abc123",
        hadEntry: true,
        hasEntry: false,
      }),
    ).toBe(false);
  });
});

describe("store wipe shape the recovery depends on", () => {
  it("resetForWorkspaceSwitch removes entries rather than emptying them", () => {
    // The predicate keys off entry *absence*, which is only a valid signal
    // while the wipe clears the map. If this ever changed to writing entries
    // holding [], the recovery above would silently stop firing.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      path.join(here, "../ui/stores/chatStore.ts"),
      "utf8",
    );

    const reset = source.slice(source.indexOf("resetForWorkspaceSwitch:"));
    const body = reset.slice(0, reset.indexOf("}),") + 3);

    expect(body).toContain("chatStates: new Map()");
  });
});
