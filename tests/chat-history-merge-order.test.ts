/**
 * Merging server history into a chat must not reorder the conversation.
 *
 * The bug these cover: the server list is a *window* — loadMessages asks for
 * the newest 30 — but the merge treated any local message missing from that
 * window as an optimistic send and appended it to the end. Once the user had
 * scrolled up and paginated older turns into view, the next history sync moved
 * every one of those older turns *below* the newest message.
 */

import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../ui/types/chat";

// The module under test transitively imports the gateway client, which opens a
// WebSocket in its constructor and schedules reconnect timers on failure. Stub
// it so this stays a pure unit test instead of depending on a running gateway.
vi.mock("../ui/src/lib/gateway", () => ({
  gateway: { send: vi.fn(), onBroadcast: vi.fn(), isConnected: () => false },
  GATEWAY_DISCONNECTED_ERROR: "Gateway disconnected",
}));

import { mergeHistoryWithLocal } from "../ui/lib/agentStreamRecovery";

function msg(id: string, role: "user" | "assistant" = "user"): ChatMessage {
  // Server-mapped messages carry no timestamp (see mapHistoryMessages), so the
  // fixtures omit it too — placement must not depend on one.
  return { id, role, content: `body ${id}` } as ChatMessage;
}

/** m01..mNN, chronological, as the store holds them. */
function conversation(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) =>
    msg(
      `m${String(i + 1).padStart(2, "0")}`,
      i % 2 === 0 ? "user" : "assistant",
    ),
  );
}

const ids = (messages: ChatMessage[]) => messages.map((m) => m.id);

describe("mergeHistoryWithLocal ordering", () => {
  it("keeps paginated older turns above the fetched window", () => {
    // The user scrolled up, so the store holds 50 turns. A routine history
    // sync fetches only the newest 30.
    const local = conversation(50);
    const serverWindow = local.slice(20).map((m) => msg(m.id, m.role as never));

    const merged = mergeHistoryWithLocal(local, serverWindow);

    expect(ids(merged)).toEqual(ids(local));
  });

  it("still appends an optimistic send the server has not stored yet", () => {
    const local = [...conversation(4), msg("pending-user")];
    const serverWindow = conversation(4);

    const merged = mergeHistoryWithLocal(local, serverWindow);

    expect(ids(merged)).toEqual(["m01", "m02", "m03", "m04", "pending-user"]);
  });

  it("places older and newer strays on their own sides of the window", () => {
    const local = [
      msg("old-a"),
      msg("old-b"),
      ...conversation(3),
      msg("pending-user"),
    ];
    const serverWindow = conversation(3);

    const merged = mergeHistoryWithLocal(local, serverWindow);

    expect(ids(merged)).toEqual([
      "old-a",
      "old-b",
      "m01",
      "m02",
      "m03",
      "pending-user",
    ]);
  });

  it("leaves a full history untouched when nothing was paginated", () => {
    const local = conversation(6);
    const server = conversation(6);

    expect(ids(mergeHistoryWithLocal(local, server))).toEqual(ids(local));
  });

  it("keeps local order when the server returns nothing", () => {
    const local = conversation(3);

    expect(ids(mergeHistoryWithLocal(local, []))).toEqual(ids(local));
  });

  it("adds server turns the store is missing, in place", () => {
    // The gap-filling the merge already did must survive the fix.
    const local = [msg("m01"), msg("m03")];
    const server = [msg("m01"), msg("m02"), msg("m03")];

    expect(ids(mergeHistoryWithLocal(local, server))).toEqual([
      "m01",
      "m02",
      "m03",
    ]);
  });
});
