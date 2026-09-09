import { describe, expect, it } from "vitest";
import { clearQueuedMessagesForChat } from "../ui/utils/messageQueue";
import type { QueuedMessage } from "../ui/components/Chat/QueuedMessages";

function queued(id: string, chatId: string, text: string): QueuedMessage {
  return { id, chatId, text, timestamp: Date.now() };
}

describe("clearQueuedMessagesForChat", () => {
  it("removes only messages for the target chat", () => {
    const queue = [
      queued("a", "chat-1", "stop"),
      queued("b", "chat-2", "other"),
      queued("c", "chat-1", "hi"),
    ];

    expect(clearQueuedMessagesForChat(queue, "chat-1")).toEqual([
      queued("b", "chat-2", "other"),
    ]);
  });

  it("returns the same array contents when no messages match", () => {
    const queue = [queued("a", "chat-2", "hello")];
    expect(clearQueuedMessagesForChat(queue, "chat-1")).toEqual(queue);
  });
});
