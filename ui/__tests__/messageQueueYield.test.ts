import { describe, expect, it } from "vitest";
import type { QueuedMessage } from "../components/Chat/QueuedMessages";
import { hasOtherSendableQueued } from "../utils/messageQueue";

const item = (id: string, chatId: string, held = false): QueuedMessage =>
  ({ id, chatId, text: id, timestamp: 0, ...(held ? { held: true } : {}) }) as QueuedMessage;

describe("hasOtherSendableQueued — when removing a queued follow-up must withdraw its pause", () => {
  it("removing the only follow-up withdraws the pause", () => {
    expect(hasOtherSendableQueued([item("a", "c1")], "c1", "a")).toBe(false);
  });

  it("another sendable follow-up in the same chat keeps it", () => {
    expect(hasOtherSendableQueued([item("a", "c1"), item("b", "c1")], "c1", "a")).toBe(true);
  });

  it("follow-ups for other chats do not count", () => {
    expect(hasOtherSendableQueued([item("a", "c1"), item("b", "c2")], "c1", "a")).toBe(false);
  });

  it("held (unsent, from a previous session) follow-ups do not count", () => {
    expect(hasOtherSendableQueued([item("a", "c1"), item("b", "c1", true)], "c1", "a")).toBe(false);
  });
});
