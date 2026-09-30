/**
 * A mounted chat pane hydrates its messages once, in an effect keyed on chatId.
 * Anything that drops the chat's entry from the store while the pane stays
 * mounted therefore strands it: the pane renders the welcome screen and nothing
 * re-runs the fetch. `resetForWorkspaceSwitch()` clears every entry and the
 * workspace reload restores tabs without restoring message bodies, so the pane
 * can outlive its own state.
 *
 * This predicate decides whether such a disappearance should trigger a reload.
 */
export interface ChatStateRecoveryInput {
  chatId: string;
  /** Whether the store held an entry for this chat on the previous render. */
  hadEntry: boolean;
  /** Whether the store holds an entry for this chat now. */
  hasEntry: boolean;
}

export function shouldRehydrateAfterStoreWipe({
  chatId,
  hadEntry,
  hasEntry,
}: ChatStateRecoveryInput): boolean {
  // Only the present -> absent transition indicates a wipe. An entry that is
  // merely empty belongs to a new chat, which has nothing to load.
  if (!hadEntry || hasEntry) return false;

  // A temp chat has no server-side rows to load, and migrateChatId removes the
  // temp entry a tick before the tab switches to the permanent id — so this
  // transition is expected there and must not fire a fetch.
  if (chatId.startsWith("temp-")) return false;

  return true;
}
