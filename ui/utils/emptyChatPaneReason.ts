/**
 * Why is this chat pane empty — because the chat is new, or because we could
 * not read it?
 *
 * Both produce `messages: []`, and the welcome screen ("What would you like to
 * build?") is a confident statement about the first. Shown for the second it
 * tells a user whose conversation is intact in SQLite that it never existed,
 * which reads as data loss.
 */

export type EmptyChatPaneReason = "new-chat" | "load-failed";

export interface EmptyChatPaneInput {
  /** The last history load threw rather than returning a list. */
  historyLoadFailed: boolean;
  /**
   * `messageCount` from chat metadata, or undefined when metadata is not
   * available — which is common in the boot window, because the chat list is
   * fetched over the same gateway that just failed us.
   */
  knownMessageCount?: number;
}

export function resolveEmptyChatPaneReason({
  historyLoadFailed,
  knownMessageCount,
}: EmptyChatPaneInput): EmptyChatPaneReason {
  if (!historyLoadFailed) {
    return "new-chat";
  }

  // Positive evidence of emptiness beats the failure: the gateway told us
  // this chat has no messages, so an empty pane is correct and the welcome
  // screen is the more useful thing to show.
  if (knownMessageCount === 0) {
    return "new-chat";
  }

  // Otherwise the load failed and we cannot rule out history. Report the
  // failure. The two mistakes are not symmetric — greeting someone whose
  // conversation exists looks like data loss and sends them hunting for a
  // backup, while reporting a gateway that is genuinely down to someone
  // starting a fresh chat is merely redundant, since they cannot send a
  // message either way.
  return "load-failed";
}
