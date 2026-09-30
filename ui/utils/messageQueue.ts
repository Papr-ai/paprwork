import type { QueuedMessage } from "../components/Chat/QueuedMessages";

/** Drop all queued messages for one chat (stop / interrupt-and-send). */
export function clearQueuedMessagesForChat(
  queue: QueuedMessage[],
  chatId: string,
): QueuedMessage[] {
  return queue.filter((item) => item.chatId !== chatId);
}
