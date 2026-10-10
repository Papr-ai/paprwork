import type { QueuedMessage } from "../components/Chat/QueuedMessages";

/** Drop all queued messages for one chat (stop / interrupt-and-send). */
export function clearQueuedMessagesForChat(
  queue: QueuedMessage[],
  chatId: string,
): QueuedMessage[] {
  return queue.filter((item) => item.chatId !== chatId);
}

/**
 * True when `chatId` still has a follow-up that will send after the current
 * step once `removedId` is gone. Queueing a follow-up asks the running turn to
 * pause at its next tool boundary (`agent:yield`); removing or editing the
 * last one has to withdraw that request, or the turn stops for a message that
 * never arrives and ends with no reply.
 */
export function hasOtherSendableQueued(
  queue: QueuedMessage[],
  chatId: string,
  removedId: string,
): boolean {
  return queue.some(
    (item) => item.chatId === chatId && item.id !== removedId && !item.held,
  );
}
