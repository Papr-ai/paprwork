/**
 * Marker the UI prepends to automatic stream-recovery turns. Shared by the UI,
 * the agent, and telemetry: if these drifted apart, recovery turns would start
 * counting as user activity in the Active 7D/30D metrics without any error.
 */
export const HIDDEN_CONTINUE_PREFIX = "[__papr_continue__]";

export function isHiddenContinueMessage(content: string): boolean {
  return content.startsWith(HIDDEN_CONTINUE_PREFIX);
}
